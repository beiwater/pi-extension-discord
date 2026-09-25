import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertBotModelConfigured, createInstalledPiModelRuntime } from "../agent/model-runtime.ts";
import { log, errorCategory } from "../observability/log.ts";
import { downloadDiscordImage, prepareDiscordImageForPi } from "./media.ts";
import type { DiscordInboundMessage, DiscordPersona } from "./core.ts";
import { DiscordConversationCore } from "./core.ts";
import { DiscordMemberMemory } from "./memory.ts";
import { DiscordSoulStore } from "./soul.ts";
import { DiscordCelebrationScheduler } from "./celebrations.ts";
import { loadDiscordConfig, ensureDeepSeekModelsFile } from "./config.ts";
import { DiscordTransport, DiscordTransportPool, type DiscordInteraction, type DiscordMessage } from "./transport.ts";

const COMMANDS = [
	{ name: "help", description: "Show bot commands" },
	{ name: "status", description: "Show bot status" },
	{
		name: "ask",
		description: "Ask the assistants",
		options: [{ name: "prompt", description: "What would you like to ask?", type: 3, required: true }],
	},
	{
		name: "memory",
		description: "View or re-enable your own server memory",
		options: [
			{
				name: "action",
				description: "show or enable",
				type: 3,
				required: false,
				choices: [
					{ name: "Show", value: "show" },
					{ name: "Enable", value: "enable" },
				],
			},
		],
	},
	{
		name: "birthday",
		description: "View, set, or clear your own birthday reminder",
		options: [{ name: "date", description: "MM-DD, or clear; leave empty to view", type: 3, required: false }],
	},
	{ name: "forget", description: "Delete your server memory and stop collecting it" },
];
const ADMIN_COMMANDS = [
	{ name: "context", description: "Show this channel's context usage (bot admin only)" },
	{ name: "compact", description: "Compact this channel's context (bot admin only)" },
];

async function normalizeMessage(
	message: DiscordMessage,
	allowedGuilds: ReadonlyMap<string, ReadonlySet<string>>,
	parentChannelId?: string,
): Promise<DiscordInboundMessage | null> {
	const actualGuild = (message as DiscordMessage & { guild_id?: unknown }).guild_id;
	const allowedChannels = typeof actualGuild === "string" ? allowedGuilds.get(actualGuild) : undefined;
	if (
		!allowedChannels ||
		!(allowedChannels.has(message.channel_id) || (parentChannelId && allowedChannels.has(parentChannelId)))
	)
		return null;
	const images: NonNullable<DiscordInboundMessage["images"]>[number][] = [];
	for (const attachment of (message.attachments ?? []).slice(0, 4)) {
		if (!attachment.content_type?.toLowerCase().startsWith("image/")) continue;
		const downloaded = await downloadDiscordImage({
			url: attachment.url,
			filename: attachment.filename,
			contentType: attachment.content_type,
			size: attachment.size,
		});
		if (!downloaded.ok) continue;
		const prepared = await prepareDiscordImageForPi(downloaded);
		if (prepared.ok)
			images.push({ filename: downloaded.filename, mimeType: prepared.image.mimeType, base64: prepared.image.data });
	}
	const reply = message.referenced_message;
	const channelId = message.channel_id;
	return {
		guildId: actualGuild as string,
		channelId,
		messageId: message.id,
		authorId: message.author.id,
		authorName: message.author.username,
		username: message.author.username,
		isBot: message.author.bot === true,
		content: message.content ?? "",
		mentionedUserIds: (message.mentions ?? []).map((mention) => mention.id),
		replyToMessageId: message.message_reference?.message_id ?? null,
		replyToAuthorId: reply?.author.id ?? null,
		timestamp: Date.parse(String(message.timestamp ?? "")) || Date.now(),
		images,
	};
}

function getOption(interaction: DiscordInteraction, name: string): string | undefined {
	const options = interaction.data?.options;
	if (!Array.isArray(options)) return undefined;
	const found = options.find((item) => item && typeof item === "object" && (item as { name?: unknown }).name === name);
	return found && typeof (found as { value?: unknown }).value === "string"
		? (found as { value: string }).value
		: undefined;
}

async function main(): Promise<void> {
	const loaded = loadDiscordConfig();
	const { config, env } = loaded;
	const agentDir = join(config.dataDir, "pi-agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	ensureDeepSeekModelsFile(agentDir);
	const tokenByPersona = new Map(config.personas.map((persona) => [persona.id, env[persona.token_env]!]));
	for (const [personaId, token] of tokenByPersona) {
		const owner = config.personas.find((persona) => persona.id === personaId)!;
		process.env[owner.token_env] = token;
	}
	// Pi resolves the key reference in the project-local models.json at request time.
	if (env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
	const routingSecret = env[config.routingSecretEnv]!;
	const personas: DiscordPersona[] = config.personas.map((persona) => ({
		id: persona.id,
		name: persona.name,
		userId: "10000000000000001", // Replaced with Discord's verified bot identity below.
		personaPath: persona.personaPath,
		provider: persona.provider,
		model: persona.model,
		routingP: persona.routingP,
		...(persona.reasoningEffort ? { reasoningEffort: persona.reasoningEffort } : {}),
		...(persona.adminUserIds ? { adminUserIds: persona.adminUserIds } : {}),
	}));
	const allowedGuilds = new Map(config.guilds.map(({ guildId, channelIds }) => [guildId, new Set(channelIds)]));
	const allowed = new Set(config.guilds.flatMap(({ channelIds }) => channelIds));
	const transports = new Map<string, DiscordTransport>();
	const identities = new Map<string, { id: string; username: string }>();
	let core: DiscordConversationCore | undefined;
	let memberMemory: DiscordMemberMemory | undefined;
	for (const persona of config.personas) {
		const token = tokenByPersona.get(persona.id)!;
		const probe = new DiscordTransport({ token, applicationId: "10000000000000001" });
		const identity = await probe.getCurrentUser();
		identities.set(persona.id, identity);
		let transport!: DiscordTransport;
		transport = new DiscordTransport({
			token,
			applicationId: identity.id,
			allowedChannelIds: allowed,
			onError: (error) =>
				log.error("discord", "transport_error", { persona_id: persona.id, error_category: errorCategory(error) }),
			onMessage: async (message) => {
				try {
					const normalized = await normalizeMessage(
						message,
						allowedGuilds,
						transport.getParentChannelId(message.channel_id),
					);
					if (normalized && core) await core.handleMessage(normalized);
				} catch (error) {
					log.error("discord", "message_failed", { persona_id: persona.id, error_category: errorCategory(error) });
				}
			},
			onInteraction: async (interaction) => {
				const interactionGuild =
					typeof interaction.guild_id === "string" ? allowedGuilds.get(interaction.guild_id) : undefined;
				if (
					!interactionGuild ||
					!interaction.channel_id ||
					!(
						interactionGuild.has(interaction.channel_id) ||
						interactionGuild.has(transport.getParentChannelId(interaction.channel_id) ?? "")
					)
				)
					return;
				const name = interaction.data?.name;
				if (name === "memory" || name === "birthday" || name === "forget") {
					const author = interaction.member?.user ?? interaction.user;
					if (!author || !memberMemory || !interaction.guild_id) return;
					try {
						if (name === "forget") {
							memberMemory.forgetMember(interaction.guild_id, author.id);
							await transport.respondToInteraction(
								interaction,
								"已删除你在这个服务器的长期档案和关系记录，并停止继续建立档案。频道原有聊天记录仍按服务器现有设置保存。",
								{ ephemeral: true },
							);
							return;
						}
						if (name === "memory") {
							if (getOption(interaction, "action") === "enable") {
								memberMemory.enableMember(interaction.guild_id, author.id);
								await transport.respondToInteraction(
									interaction,
									"已重新启用你在这个服务器的长期记忆。今后的消息会建立新档案。",
									{ ephemeral: true },
								);
								return;
							}
							const profile = memberMemory.getProfile(interaction.guild_id, author.id);
							const details = profile
								? [
										`名称：${profile.name}`,
										`已记录消息：${profile.messageCount}`,
										`生日：${profile.birthday ? `${profile.birthday.month}月${profile.birthday.day}日` : "未记录"}`,
										...profile.facts.slice(0, 6).map((fact) => `${fact.key}：${fact.value}`),
										...profile.relationships.slice(0, 5).map((relation) => `${relation.type}：${relation.name}`),
									]
										.join("\n")
										.slice(0, 1800)
								: "这个服务器里暂无你的长期档案，或者你已关闭记忆。可用 `/memory action:enable` 重新启用。";
							await transport.respondToInteraction(interaction, details, { ephemeral: true });
							return;
						}
						const date = getOption(interaction, "date")?.trim();
						if (!date) {
							const birthday = memberMemory.getProfile(interaction.guild_id, author.id)?.birthday;
							await transport.respondToInteraction(
								interaction,
								birthday
									? `已记录生日：${birthday.month}月${birthday.day}日。`
									: "还没有记录生日。使用 `/birthday date:MM-DD` 设置。",
								{ ephemeral: true },
							);
							return;
						}
						if (date.toLowerCase() === "clear") {
							memberMemory.clearBirthday(interaction.guild_id, author.id);
							await transport.respondToInteraction(interaction, "已清除生日提醒。", { ephemeral: true });
							return;
						}
						const match = /^(\d{1,2})-(\d{1,2})$/.exec(date);
						if (!match) {
							await transport.respondToInteraction(interaction, "请输入 MM-DD，例如 09-25；或输入 clear 清除。", {
								ephemeral: true,
							});
							return;
						}
						const month = Number(match[1]);
						const day = Number(match[2]);
						memberMemory.setBirthday(
							interaction.guild_id,
							author.id,
							month,
							day,
							interaction.channel_id,
							interaction.id,
						);
						const celebrationChannel = config.celebrations?.find(
							(target) => target.guildId === interaction.guild_id,
						)?.channelId;
						await transport.respondToInteraction(
							interaction,
							`已在这个服务器记录你的生日：${month}月${day}日。${celebrationChannel ? `到时会在 <#${celebrationChannel}> 祝福。` : "这个服务器尚未启用自动生日祝福。"}`,
							{ ephemeral: true },
						);
					} catch (error) {
						log.error("discord", "memory_command_failed", { error_category: errorCategory(error) });
						await transport.respondToInteraction(
							interaction,
							error instanceof Error && error.message === "memory_opted_out"
								? "你已关闭长期记忆。若要重新保存生日，请先使用 `/memory action:enable`。"
								: "记忆操作失败；请检查日期是否有效，或稍后重试。",
							{ ephemeral: true },
						);
					}
					return;
				}
				if (name === "context" || name === "compact") {
					const author = interaction.member?.user ?? interaction.user;
					if (!author || !persona.adminUserIds?.includes(author.id)) {
						await transport.respondToInteraction(interaction, "只有菲八管理员可以使用这个命令。", {
							ephemeral: true,
						});
						return;
					}
					await transport.deferInteraction(interaction, true);
					try {
						if (!core) throw new Error("missing_core");
						if (name === "context") {
							const status = await core.getContextStatus(
								persona.id,
								interaction.guild_id!,
								interaction.channel_id,
								author.id,
							);
							await transport.followUpInteraction(
								interaction,
								`当前频道上下文：${status.tokens === null ? "暂时无法估算" : `${status.tokens.toLocaleString()} tokens`} / ${status.contextWindow.toLocaleString()} tokens。自动压缩约在 ${status.compactionAtTokens.toLocaleString()} tokens 后触发；也可用 /compact 手动压缩。`,
								true,
							);
						} else {
							const result = await core.compactContext(
								persona.id,
								interaction.guild_id!,
								interaction.channel_id,
								author.id,
							);
							await transport.followUpInteraction(
								interaction,
								`已压缩本频道上下文。压缩前约 ${result.tokensBefore.toLocaleString()} tokens。`,
								true,
							);
						}
					} catch (error) {
						log.error("discord", "admin_command_failed", {
							persona_id: persona.id,
							error_category: errorCategory(error),
						});
						const reason = error instanceof Error ? error.message : "";
						const content =
							reason === "context_busy"
								? "本频道正在处理消息，稍后再试。"
								: reason === "Already compacted" || reason.startsWith("Nothing to compact")
									? "本频道目前没有需要压缩的上下文。"
									: "上下文管理失败，请稍后再试。";
						await transport.followUpInteraction(interaction, content, true);
					}
					return;
				}
				if (name === "help") {
					const author = interaction.member?.user ?? interaction.user;
					const admin = !!author && !!persona.adminUserIds?.includes(author.id);
					const help = admin
						? "Commands: `/ask`, `/status`, `/memory`, `/birthday`, `/forget`, `/context`, `/compact`"
						: "Commands: `/ask`, `/status`, `/memory`, `/birthday`, `/forget`";
					await transport.respondToInteraction(interaction, help, {
						ephemeral: true,
					});
					return;
				}
				if (name === "status") {
					const alive = [...identities.values()].map((current) => current.username).join(", ");
					await transport.respondToInteraction(interaction, `Online. Assistants: ${alive}.`, { ephemeral: true });
					return;
				}
				if (name !== "ask") return;
				const prompt = getOption(interaction, "prompt")?.trim();
				if (!prompt) {
					await transport.respondToInteraction(interaction, "Please include a prompt.", { ephemeral: true });
					return;
				}
				await transport.deferInteraction(interaction, true);
				try {
					const author = interaction.member?.user ?? interaction.user;
					if (!author || !interaction.channel_id || !core) throw new Error("missing_interaction_context");
					const dispatch = await core.handleMessage({
						guildId: interaction.guild_id!,
						channelId: interaction.channel_id,
						messageId: interaction.id,
						authorId: author.id,
						authorName: author.username,
						isBot: false,
						content: prompt,
						mentionedUserIds: [identity.id],
					});
					const status = dispatch.responseMessageId
						? "Your answer was posted in the channel."
						: dispatch.route.personaId
							? "The assistant didn't return an answer. Please try again."
							: "No assistant was selected for that request. Please try /ask again.";
					await transport.followUpInteraction(interaction, status);
				} catch (error) {
					log.error("discord", "ask_failed", { persona_id: persona.id, error_category: errorCategory(error) });
					await transport.followUpInteraction(interaction, "I couldn't complete that request. Please try again.");
				}
			},
		});
		transports.set(persona.id, transport);
	}
	for (const persona of personas) persona.userId = identities.get(persona.id)!.id;
	const runtime = await createInstalledPiModelRuntime({ cwd: loaded.rootDir, agentDir });
	for (const persona of config.personas)
		assertBotModelConfigured(
			{ provider: persona.provider, model: persona.model, thinkingLevel: persona.reasoningEffort, purpose: persona.id },
			runtime,
		);
	const pool = new DiscordTransportPool(transports);
	const dbPath = join(config.dataDir, "discord-agent.db");
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const db = new Database(dbPath);
	chmodSync(dbPath, 0o600);
	memberMemory = new DiscordMemberMemory(db);
	const soulStore = new DiscordSoulStore({
		dataDir: config.dataDir,
		personaIds: personas.map((persona) => persona.id),
	});
	core = new DiscordConversationCore({
		db,
		dataDir: config.dataDir,
		routingSecret,
		personas,
		memberMemory,
		soulStore,
		webSearchApiKey: env.DEEPSEEK_API_KEY,
		...(config.voice
			? {
					voice: {
						apiKey: env[config.voice.apiKeyEnv]!,
						referenceId: config.voice.referenceId,
						model: config.voice.model,
					},
				}
			: {}),
		transport: {
			sendMessage: async (input) => {
				const result = await pool.sendMessage({
					personaId: input.personaId,
					channelId: input.channelId,
					content: input.content,
					replyToMessageId: input.replyToMessageId,
					allowedMentions: input.allowedMentions,
					attachments: input.attachments,
				});
				return result;
			},
			startTyping: (personaId, channelId) => pool.startTyping(personaId, channelId),
			addReaction: (personaId, channelId, messageId, emoji) => pool.addReaction(personaId, channelId, messageId, emoji),
		},
		modelRuntime: runtime,
	});
	const scheduler = new DiscordCelebrationScheduler({
		db,
		targets: config.celebrations ?? [],
		listBirthdays: (guildId, month, day) => memberMemory!.listBirthdays(guildId, month, day),
		onError: (error) => log.error("discord", "celebration_failed", { error_category: errorCategory(error) }),
		send: async (personaId, channelId, content, allowedMentions) => {
			await pool.sendMessage({ personaId, channelId, content, allowedMentions });
		},
	});
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info("discord", "shutdown", { signal });
		await scheduler.stop();
		await Promise.allSettled([...transports.values()].map((transport) => transport.stop()));
		await core.close();
		db.close();
	};
	process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
	process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

	for (const [personaId, transport] of transports) {
		const persona = config.personas.find((candidate) => candidate.id === personaId)!;
		const commands = persona.adminUserIds?.length ? [...COMMANDS, ...ADMIN_COMMANDS] : COMMANDS;
		for (const { guildId } of config.guilds) await transport.registerCommands(commands, guildId);
	}
	for (const transport of transports.values()) await transport.start();
	scheduler.start();
	log.info("discord", "ready", {
		persona_count: personas.length,
		channel_count: allowed.size,
		search_enabled: !!env.DEEPSEEK_API_KEY,
		voice_enabled: !!config.voice,
		celebration_targets: config.celebrations?.length ?? 0,
	});
}

main().catch((error) => {
	log.error("discord", "startup_failed", { error_category: errorCategory(error) });
	process.exitCode = 1;
});
