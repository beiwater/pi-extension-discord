import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertBotModelConfigured, createInstalledPiModelRuntime } from "../agent/model-runtime.ts";
import { log, errorCategory } from "../observability/log.ts";
import { downloadDiscordImage, prepareDiscordImageForPi } from "./media.ts";
import type { DiscordInboundMessage, DiscordPersona } from "./core.ts";
import { DiscordConversationCore } from "./core.ts";
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
];

async function normalizeMessage(message: DiscordMessage, guildId: string): Promise<DiscordInboundMessage | null> {
	const actualGuild = (message as DiscordMessage & { guild_id?: unknown }).guild_id;
	if (actualGuild !== guildId) return null;
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
		guildId,
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
	}));
	const allowed = new Set(config.channelIds);
	const transports = new Map<string, DiscordTransport>();
	const identities = new Map<string, { id: string; username: string }>();
	let core: DiscordConversationCore | undefined;
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
					const normalized = await normalizeMessage(message, config.guildId);
					if (normalized && core) await core.handleMessage(normalized);
				} catch (error) {
					log.error("discord", "message_failed", { persona_id: persona.id, error_category: errorCategory(error) });
				}
			},
			onInteraction: async (interaction) => {
				if (interaction.guild_id !== config.guildId) return;
				const name = interaction.data?.name;
				if (name === "help") {
					await transport.respondToInteraction(interaction, "Commands: `/ask prompt`, `/status`, `/help`", {
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
						guildId: config.guildId,
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
	core = new DiscordConversationCore({
		db,
		dataDir: config.dataDir,
		routingSecret,
		personas,
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
		},
		modelRuntime: runtime,
	});
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info("discord", "shutdown", { signal });
		await Promise.allSettled([...transports.values()].map((transport) => transport.stop()));
		await core.close();
		db.close();
	};
	process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
	process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

	for (const [personaId, transport] of transports) {
		void personaId;
		await transport.registerCommands(COMMANDS, config.guildId);
	}
	for (const transport of transports.values()) await transport.start();
	log.info("discord", "ready", { persona_count: personas.length, channel_count: allowed.size });
}

main().catch((error) => {
	log.error("discord", "startup_failed", { error_category: errorCategory(error) });
	process.exitCode = 1;
});
