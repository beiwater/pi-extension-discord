/** Small Discord HTTP/Gateway transport. Snowflakes stay strings end to end. */

export type Snowflake = string;

export interface DiscordMessage {
	id: Snowflake;
	channel_id: Snowflake;
	content: string;
	author: { id: Snowflake; username: string; bot?: boolean };
	mentions?: Array<{ id: Snowflake; username?: string; bot?: boolean }>;
	attachments?: Array<{ id: Snowflake; filename: string; url: string; content_type?: string; size?: number }>;
	referenced_message?: DiscordMessage | null;
	message_reference?: { message_id?: Snowflake; channel_id?: Snowflake; guild_id?: Snowflake };
	[key: string]: unknown;
}

export interface DiscordInteraction {
	id: Snowflake;
	type: number;
	application_id: Snowflake;
	token: string;
	data?: { name?: string; options?: unknown[]; [key: string]: unknown };
	guild_id?: Snowflake;
	channel_id?: Snowflake;
	member?: { user?: { id: Snowflake; username: string; [key: string]: unknown }; [key: string]: unknown };
	user?: { id: Snowflake; username: string; [key: string]: unknown };
	[key: string]: unknown;
}

export interface DiscordCommand {
	name: string;
	description: string;
	type?: number;
	options?: unknown[];
	default_member_permissions?: string | null;
}

export interface DiscordTransportOptions {
	token: string;
	applicationId: Snowflake;
	intents?: number;
	apiBase?: string;
	apiVersion?: string;
	gatewayUrl?: string;
	allowedChannelIds?: Iterable<Snowflake>;
	fetch?: typeof fetch;
	webSocketFactory?: (url: string) => WebSocket;
	onMessage?: (message: DiscordMessage) => void | Promise<void>;
	onInteraction?: (interaction: DiscordInteraction) => void | Promise<void>;
	onError?: (error: Error) => void;
}

const API_VERSION = "10";
const API_BASE = "https://discord.com/api";
const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_ALLOWED_MENTIONS = { parse: [] as string[], replied_user: false };
const GUILDS = 1 << 0;
const GUILD_MESSAGES = 1 << 9;
const MESSAGE_CONTENT = 1 << 15;
export const DEFAULT_INTENTS = GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT;

export function isSnowflake(value: unknown): value is Snowflake {
	return typeof value === "string" && /^\d{17,20}$/.test(value);
}

/** Split without discarding whitespace; prefer a newline, then a word boundary. */
export function splitDiscordMessage(content: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
	if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error("maxLength must be a positive integer");
	if (!content) return [];
	const parts: string[] = [];
	let rest = content;
	while (rest.length > maxLength) {
		let cut = rest.lastIndexOf("\n", maxLength - 1);
		if (cut < Math.floor(maxLength * 0.55)) cut = rest.lastIndexOf(" ", maxLength - 1);
		if (cut < Math.floor(maxLength * 0.55)) cut = maxLength;
		else if (rest[cut] === "\n") cut += 1;
		// Never leave half of a UTF-16 surrogate pair at either end.
		if (
			cut < rest.length &&
			cut > 0 &&
			/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "") &&
			/[\uDC00-\uDFFF]/.test(rest[cut] ?? "")
		)
			cut -= 1;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) parts.push(rest);
	return parts;
}

export class DiscordTransport {
	private readonly fetchImpl: typeof fetch;
	private readonly apiBase: string;
	private readonly version: string;
	private readonly wsFactory: (url: string) => WebSocket;
	private socket?: WebSocket;
	private sessionId?: string;
	private resumeGatewayUrl?: string;
	private sequence: number | null = null;
	private heartbeatInterval?: ReturnType<typeof setInterval>;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private heartbeatAck = true;
	private stopped = true;
	private reconnectAttempts = 0;
	private intentionalClose = false;
	private readonly allowedChannels?: Set<Snowflake>;
	private readonly threadParents = new Map<Snowflake, Snowflake>();
	private readyUser?: { id: Snowflake; username: string };

	constructor(private readonly options: DiscordTransportOptions) {
		if (!options.token) throw new Error("Discord bot token is required");
		if (!isSnowflake(options.applicationId)) throw new Error("applicationId must be a Discord Snowflake string");
		this.fetchImpl = options.fetch ?? fetch;
		this.apiBase = (options.apiBase ?? API_BASE).replace(/\/$/, "");
		this.version = options.apiVersion ?? API_VERSION;
		this.wsFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
		this.allowedChannels = options.allowedChannelIds ? new Set(options.allowedChannelIds) : undefined;
	}

	private get apiRoot() {
		return `${this.apiBase}/v${this.version}`;
	}
	get botIdentity(): { id: Snowflake; username: string } | undefined {
		return this.readyUser;
	}

	async getCurrentUser(): Promise<{ id: Snowflake; username: string }> {
		const user = await this.request<{ id: unknown; username?: unknown }>("/users/@me");
		if (!isSnowflake(user.id)) throw new Error("Discord current user response did not include a valid id");
		return { id: user.id, username: typeof user.username === "string" ? user.username : "" };
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bot ${this.options.token}`);
		if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
		for (let attempt = 0; ; attempt++) {
			const response = await this.fetchImpl(`${this.apiRoot}${path}`, { ...init, headers });
			if (response.status === 429 && attempt < 4) {
				const retryHeader = response.headers.get("Retry-After");
				let retryAfter = retryHeader === null ? Number.NaN : Number(retryHeader);
				try {
					const data = (await response.clone().json()) as { retry_after?: unknown };
					if (typeof data.retry_after === "number" && Number.isFinite(data.retry_after)) retryAfter = data.retry_after;
				} catch {
					/* Header is the fallback; never include the body in errors. */
				}
				const delay = Math.min(120_000, Math.max(0, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000));
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			if (!response.ok) throw new Error(`Discord API request failed with HTTP ${response.status}`);
			if (response.status === 204) return undefined as T;
			return (await response.json()) as T;
		}
	}

	async sendMessage(
		channelId: Snowflake,
		content: string,
		options: {
			replyTo?: Snowflake;
			allowedMentions?: { parse?: string[]; users?: Snowflake[]; roles?: Snowflake[]; replied_user?: boolean };
			attachments?: Array<{ name: string; data: Blob | Uint8Array; contentType?: string }>;
		} = {},
	): Promise<DiscordMessage[]> {
		this.assertSnowflake(channelId, "channelId");
		this.assertAllowedChannel(channelId);
		if (options.replyTo) this.assertSnowflake(options.replyTo, "replyTo");
		const parts = splitDiscordMessage(content);
		if (!parts.length && !options.attachments?.length) return [];
		const sent: DiscordMessage[] = [];
		for (let i = 0; i < Math.max(1, parts.length); i++) {
			const body: Record<string, unknown> = {
				content: parts[i] ?? "",
				allowed_mentions: options.allowedMentions ?? DEFAULT_ALLOWED_MENTIONS,
			};
			if (i === 0 && options.replyTo)
				body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false };
			let message: DiscordMessage;
			if (i === 0 && options.attachments?.length) {
				const form = new FormData();
				form.set("payload_json", JSON.stringify(body));
				options.attachments.forEach((file, index) => {
					const blob =
						file.data instanceof Blob
							? file.data
							: new Blob([new Uint8Array(file.data).buffer as ArrayBuffer], { type: file.contentType });
					form.append(`files[${index}]`, blob, file.name);
				});
				message = await this.request(`/channels/${channelId}/messages`, { method: "POST", body: form });
			} else {
				message = await this.request(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(body) });
			}
			sent.push(message);
		}
		return sent;
	}

	async addReaction(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
		this.assertSnowflake(channelId, "channelId");
		this.assertSnowflake(messageId, "messageId");
		this.assertAllowedChannel(channelId);
		if (!isValidReactionEmoji(emoji)) throw new Error("invalid reaction emoji");
		const encoded = encodeURIComponent(emoji);
		await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, { method: "PUT" });
	}

	async startTyping(channelId: Snowflake): Promise<void> {
		this.assertSnowflake(channelId, "channelId");
		this.assertAllowedChannel(channelId);
		await this.request(`/channels/${channelId}/typing`, { method: "POST" });
	}

	async registerCommands(commands: DiscordCommand[], guildId?: Snowflake): Promise<unknown[]> {
		if (guildId) this.assertSnowflake(guildId, "guildId");
		const scope = guildId ? `/guilds/${guildId}` : "";
		return this.request(`/applications/${this.options.applicationId}${scope}/commands`, {
			method: "PUT",
			body: JSON.stringify(commands),
		});
	}

	async respondToInteraction(
		interaction: DiscordInteraction,
		content: string,
		options: {
			ephemeral?: boolean;
			allowedMentions?: { parse?: string[]; users?: Snowflake[]; roles?: Snowflake[]; replied_user?: boolean };
		} = {},
	): Promise<void> {
		const flags = options.ephemeral ? 64 : 0;
		await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
			method: "POST",
			body: JSON.stringify({
				type: 4,
				data: {
					content: splitDiscordMessage(content)[0] ?? "",
					flags,
					allowed_mentions: options.allowedMentions ?? DEFAULT_ALLOWED_MENTIONS,
				},
			}),
		});
		const rest = splitDiscordMessage(content).slice(1);
		for (const part of rest) {
			await this.request(`/webhooks/${interaction.application_id}/${interaction.token}`, {
				method: "POST",
				body: JSON.stringify({ content: part, allowed_mentions: options.allowedMentions ?? DEFAULT_ALLOWED_MENTIONS }),
			});
		}
	}

	async deferInteraction(interaction: DiscordInteraction, ephemeral = false): Promise<void> {
		await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
			method: "POST",
			body: JSON.stringify({ type: 5, data: ephemeral ? { flags: 64 } : {} }),
		});
	}

	async followUpInteraction(interaction: DiscordInteraction, content: string): Promise<void> {
		for (const part of splitDiscordMessage(content)) {
			await this.request(`/webhooks/${interaction.application_id}/${interaction.token}`, {
				method: "POST",
				body: JSON.stringify({ content: part, allowed_mentions: DEFAULT_ALLOWED_MENTIONS }),
			});
		}
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.intentionalClose = true;
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.heartbeatInterval = undefined;
		this.reconnectTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket && socket.readyState < 2) socket.close(1000, "shutdown");
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		try {
			let url = this.sessionId && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.options.gatewayUrl;
			if (!url) {
				const response = await this.request<{ url: string }>("/gateway/bot");
				url = response.url;
			}
			const wsUrl = new URL(url);
			wsUrl.searchParams.set("v", this.version);
			wsUrl.searchParams.set("encoding", "json");
			const socket = this.wsFactory(wsUrl.toString());
			this.socket = socket;
			socket.onopen = () => {
				this.reconnectAttempts = 0;
			};
			socket.onmessage = (event) => {
				void this.handlePayload(String(event.data));
			};
			socket.onerror = () => this.options.onError?.(new Error("Discord Gateway WebSocket error"));
			socket.onclose = (event) => {
				if (this.socket === socket) this.socket = undefined;
				this.clearHeartbeat();
				if (!this.stopped && !this.intentionalClose) {
					if (
						event.code === 4004 ||
						event.code === 4010 ||
						event.code === 4011 ||
						event.code === 4013 ||
						event.code === 4014
					) {
						this.options.onError?.(new Error(`Discord Gateway closed with unrecoverable code ${event.code}`));
						this.stopped = true;
					} else if (event.code === 4007 || event.code === 4009) {
						this.sessionId = undefined;
						this.sequence = null;
						this.scheduleReconnect(false);
					} else this.scheduleReconnect(true);
				}
				this.intentionalClose = false;
			};
		} catch (error) {
			this.options.onError?.(asError(error));
			this.scheduleReconnect(Boolean(this.sessionId));
		}
	}

	private async handlePayload(raw: string): Promise<void> {
		let payload: { op: number; t?: string | null; s?: number | null; d?: any };
		try {
			payload = JSON.parse(raw);
		} catch {
			this.options.onError?.(new Error("Invalid Discord Gateway JSON"));
			return;
		}
		if (typeof payload.s === "number") this.sequence = payload.s;
		switch (payload.op) {
			case 10: {
				this.heartbeatAck = true;
				const interval = Number(payload.d?.heartbeat_interval);
				if (!Number.isFinite(interval) || interval < 1000) {
					this.options.onError?.(new Error("Invalid Gateway heartbeat interval"));
					this.socket?.close(4000);
					return;
				}
				this.clearHeartbeat();
				this.heartbeatInterval = setInterval(() => {
					if (!this.heartbeatAck) {
						this.socket?.close(4000, "heartbeat timeout");
						return;
					}
					this.sendGateway(1, this.sequence);
					this.heartbeatAck = false;
				}, interval);
				this.sendGateway(
					this.sessionId ? 6 : 2,
					this.sessionId
						? { token: this.options.token, session_id: this.sessionId, seq: this.sequence }
						: {
								token: this.options.token,
								intents: this.options.intents ?? DEFAULT_INTENTS,
								properties: {
									os: process.platform,
									browser: "pi-extension-discord-agent",
									device: "pi-extension-discord-agent",
								},
							},
				);
				break;
			}
			case 1:
				this.sendGateway(1, this.sequence);
				break;
			case 7:
				this.socket?.close(4000, "server requested reconnect");
				break;
			case 9:
				if (!payload.d) {
					this.sessionId = undefined;
					this.sequence = null;
				}
				this.socket?.close(4000, "invalid session");
				break;
			case 11:
				this.heartbeatAck = true;
				break;
			case 0:
				if (payload.t === "READY") {
					this.sessionId = payload.d?.session_id;
					this.resumeGatewayUrl = payload.d?.resume_gateway_url;
					this.reconnectAttempts = 0;
				}
				if (payload.t === "RESUMED") this.reconnectAttempts = 0;
				if (
					(payload.t === "THREAD_CREATE" || payload.t === "THREAD_UPDATE") &&
					isSnowflake(payload.d?.id) &&
					isSnowflake(payload.d?.parent_id)
				)
					this.threadParents.set(payload.d.id, payload.d.parent_id);
				if (payload.t === "THREAD_DELETE" && isSnowflake(payload.d?.id)) this.threadParents.delete(payload.d.id);
				if (payload.t === "READY" && isSnowflake(payload.d?.user?.id))
					this.readyUser = { id: payload.d.user.id, username: String(payload.d.user.username ?? "") };
				if (payload.t === "MESSAGE_CREATE" && payload.d && this.isAllowedEventChannel(payload.d.channel_id)) {
					void Promise.resolve(this.options.onMessage?.(payload.d as DiscordMessage)).catch((error) =>
						this.options.onError?.(asError(error)),
					);
				}
				if (payload.t === "INTERACTION_CREATE" && payload.d && this.isAllowedEventChannel(payload.d.channel_id)) {
					void Promise.resolve(this.options.onInteraction?.(payload.d as DiscordInteraction)).catch((error) =>
						this.options.onError?.(asError(error)),
					);
				}
				break;
		}
	}

	private sendGateway(op: number, d: unknown): void {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ op, d }));
	}
	private clearHeartbeat(): void {
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		this.heartbeatInterval = undefined;
	}
	private scheduleReconnect(resume: boolean): void {
		if (this.stopped || this.reconnectTimer) return;
		if (!resume) {
			this.sessionId = undefined;
			this.sequence = null;
		}
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 5)) + Math.floor(Math.random() * 500);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
	}
	private assertSnowflake(value: string, name: string): void {
		if (!isSnowflake(value)) throw new Error(`${name} must be a Discord Snowflake string`);
	}
	private assertAllowedChannel(channelId: Snowflake): void {
		if (!this.isAllowedEventChannel(channelId)) throw new Error("Discord channel is outside the configured allowlist");
	}
	private isAllowedEventChannel(channelId: unknown): boolean {
		if (!isSnowflake(channelId) || !this.allowedChannels) return isSnowflake(channelId);
		return this.allowedChannels.has(channelId) || this.allowedChannels.has(this.threadParents.get(channelId) ?? "");
	}
}

/** Discord accepts a Unicode emoji or a custom emoji written as name:id. */
export function isValidReactionEmoji(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value) return false;
	if (/^[A-Za-z0-9_]{2,32}:\d{17,20}$/.test(value)) return true;
	if (/[:\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return false;
	return /\p{Extended_Pictographic}/u.test(value) || /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(value);
}

/** Persona router: each instance owns one bot token and its corresponding identity. */
export class DiscordTransportPool {
	constructor(private readonly transports: ReadonlyMap<string, DiscordTransport>) {}

	async sendMessage(input: {
		personaId: string;
		channelId: Snowflake;
		content: string;
		replyToMessageId?: Snowflake;
		allowedMentions?: readonly string[];
		attachments?: Array<{ name: string; data: Blob | Uint8Array; contentType?: string }>;
	}): Promise<{ id: Snowflake }> {
		const transport = this.get(input.personaId);
		const users = input.allowedMentions ?? [];
		if (users.length > 100) throw new Error("allowedMentions cannot include more than 100 users");
		for (const userId of users)
			if (!isSnowflake(userId)) throw new Error("allowedMentions must contain Discord user Snowflake strings");
		const messages = await transport.sendMessage(input.channelId, input.content, {
			replyTo: input.replyToMessageId,
			allowedMentions: { parse: [], users: [...new Set(users)], replied_user: false },
			attachments: input.attachments,
		});
		const first = messages[0];
		if (!first) throw new Error("Discord send produced no message");
		return { id: first.id };
	}

	startTyping(personaId: string, channelId: Snowflake): Promise<void> {
		return this.get(personaId).startTyping(channelId);
	}

	addReaction(personaId: string, channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<void> {
		return this.get(personaId).addReaction(channelId, messageId, emoji);
	}

	private get(personaId: string): DiscordTransport {
		const transport = this.transports.get(personaId);
		if (!transport) throw new Error(`No Discord transport configured for persona ${personaId}`);
		return transport;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
