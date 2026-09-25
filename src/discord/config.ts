import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSnowflake } from "./transport.ts";

export interface DiscordConfig {
	guilds: Array<{ guildId: string; channelIds: string[] }>;
	dataDir: string;
	routingSecretEnv: string;
	voice?: DiscordConfigVoice;
	celebrations?: DiscordCelebrationTarget[];
	personas: DiscordConfigPersona[];
}

export interface DiscordCelebrationTarget {
	guildId: string;
	channelId: string;
	personaId: string;
	timeZone: string;
	calendar: "china" | "australia" | "both";
}

export interface DiscordConfigVoice {
	apiKeyEnv: string;
	referenceId: string;
	model: "s2.1-pro-free" | "s2.1-pro";
}

export interface DiscordConfigPersona {
	id: string;
	name: string;
	token_env: string;
	personaPath: string;
	routingP: number;
	provider: string;
	model: string;
	reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	adminUserIds?: string[];
}

export interface LoadedDiscordConfig {
	config: DiscordConfig;
	rootDir: string;
	dataDir: string;
	env: Record<string, string>;
}

/** Parse this project's key: value secret format; never expose values in diagnostics. */
export function parseDiscordEnv(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const env: Record<string, string> = {};
	for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) throw new Error(`Invalid .env syntax at line ${index + 1}; expected key: value`);
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid .env key at line ${index + 1}`);
		env[key] = value;
	}
	return env;
}

export function validateDiscordConfig(input: unknown, rootDir: string): DiscordConfig {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Discord config must be a JSON object");
	const value = input as Record<string, unknown>;
	if (!Array.isArray(value.guilds) || value.guilds.length === 0)
		throw new Error("guilds must contain at least one guild");
	const seenGuildIds = new Set<string>();
	const guilds = value.guilds.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`guilds[${index}] must be an object`);
		const guild = entry as Record<string, unknown>;
		if (!isSnowflake(guild.guildId)) throw new Error(`guilds[${index}].guildId must be a Discord Snowflake string`);
		if (seenGuildIds.has(guild.guildId)) throw new Error(`Duplicate guild ID: ${guild.guildId}`);
		seenGuildIds.add(guild.guildId);
		if (
			!Array.isArray(guild.channelIds) ||
			guild.channelIds.length === 0 ||
			guild.channelIds.some((id) => !isSnowflake(id))
		)
			throw new Error(`guilds[${index}].channelIds must be a nonempty array of Discord Snowflake strings`);
		return { guildId: guild.guildId, channelIds: [...new Set(guild.channelIds as string[])] };
	});
	if (!Array.isArray(value.personas) || value.personas.length === 0)
		throw new Error("personas must contain at least one bot");
	if (typeof value.routingSecretEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.routingSecretEnv))
		throw new Error("routingSecretEnv must name an environment variable");
	let voice: DiscordConfigVoice | undefined;
	if (value.voice !== undefined) {
		if (!value.voice || typeof value.voice !== "object" || Array.isArray(value.voice))
			throw new Error("voice must be an object");
		const input = value.voice as Record<string, unknown>;
		if (typeof input.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv))
			throw new Error("voice.apiKeyEnv must name an environment variable");
		if (typeof input.referenceId !== "string" || !/^[0-9a-f]{32}$/i.test(input.referenceId))
			throw new Error("voice.referenceId must be a Fish Audio voice id");
		if (input.model !== undefined && input.model !== "s2.1-pro-free" && input.model !== "s2.1-pro")
			throw new Error("voice.model must be s2.1-pro-free or s2.1-pro");
		voice = {
			apiKeyEnv: input.apiKeyEnv,
			referenceId: input.referenceId,
			model: (input.model as DiscordConfigVoice["model"] | undefined) ?? "s2.1-pro-free",
		};
	}
	const seenIds = new Set<string>();
	let routingTotal = 0;
	const personas = value.personas.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`personas[${index}] must be an object`);
		const persona = entry as Record<string, unknown>;
		for (const field of ["id", "name", "token_env", "personaPath", "provider", "model"] as const)
			if (typeof persona[field] !== "string" || !persona[field].trim())
				throw new Error(`personas[${index}].${field} is required`);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(persona.token_env as string))
			throw new Error(`personas[${index}].token_env must name an environment variable`);
		if (seenIds.has(persona.id as string)) throw new Error(`Duplicate persona id: ${persona.id}`);
		seenIds.add(persona.id as string);
		if (
			typeof persona.routingP !== "number" ||
			!Number.isFinite(persona.routingP) ||
			persona.routingP < 0 ||
			persona.routingP > 1
		)
			throw new Error(`personas[${index}].routingP must be between 0 and 1`);
		routingTotal += persona.routingP;
		const reasoningEffort = persona.reasoningEffort;
		if (
			reasoningEffort !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(reasoningEffort))
		)
			throw new Error(`personas[${index}].reasoningEffort is invalid`);
		if (
			persona.adminUserIds !== undefined &&
			(!Array.isArray(persona.adminUserIds) || persona.adminUserIds.some((id) => !isSnowflake(id)))
		)
			throw new Error(`personas[${index}].adminUserIds must be Discord Snowflake strings`);
		return {
			id: persona.id as string,
			name: persona.name as string,
			token_env: persona.token_env as string,
			personaPath: resolve(rootDir, persona.personaPath as string),
			provider: persona.provider as string,
			model: persona.model as string,
			routingP: persona.routingP,
			...(reasoningEffort ? { reasoningEffort: reasoningEffort as DiscordConfigPersona["reasoningEffort"] } : {}),
			...(persona.adminUserIds ? { adminUserIds: [...new Set(persona.adminUserIds as string[])] } : {}),
		};
	});
	if (routingTotal > 1 + Number.EPSILON) throw new Error("The sum of persona routingP values must not exceed 1");
	let celebrations: DiscordCelebrationTarget[] | undefined;
	if (value.celebrations !== undefined) {
		if (!Array.isArray(value.celebrations)) throw new Error("celebrations must be an array");
		const seenTargets = new Set<string>();
		celebrations = value.celebrations.map((entry, index) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry))
				throw new Error(`celebrations[${index}] must be an object`);
			const target = entry as Record<string, unknown>;
			const guild = guilds.find((candidate) => candidate.guildId === target.guildId);
			if (!guild || !guild.channelIds.includes(String(target.channelId)))
				throw new Error(`celebrations[${index}] must use an allowed guild channel`);
			if (!personas.some((candidate) => candidate.id === target.personaId))
				throw new Error(`celebrations[${index}].personaId must name a configured persona`);
			if (typeof target.timeZone !== "string")
				throw new Error(`celebrations[${index}].timeZone must be an IANA time zone`);
			try {
				new Intl.DateTimeFormat("en", { timeZone: target.timeZone });
			} catch {
				throw new Error(`celebrations[${index}].timeZone must be an IANA time zone`);
			}
			if (target.calendar !== "china" && target.calendar !== "australia" && target.calendar !== "both")
				throw new Error(`celebrations[${index}].calendar is invalid`);
			const key = `${target.guildId}:${target.channelId}`;
			if (seenTargets.has(key)) throw new Error(`Duplicate celebration target: ${key}`);
			seenTargets.add(key);
			return {
				guildId: target.guildId as string,
				channelId: target.channelId as string,
				personaId: target.personaId as string,
				timeZone: target.timeZone,
				calendar: target.calendar,
			};
		});
	}
	return {
		guilds,
		...(celebrations ? { celebrations } : {}),
		dataDir:
			typeof value.dataDir === "string" && value.dataDir.trim()
				? resolve(rootDir, value.dataDir)
				: resolve(rootDir, "data"),
		routingSecretEnv: value.routingSecretEnv,
		...(voice ? { voice } : {}),
		personas,
	};
}

export function loadDiscordConfig(rootDir = process.cwd()): LoadedDiscordConfig {
	const configPath = join(rootDir, "discord.config.json");
	if (!existsSync(configPath))
		throw new Error(`Missing ${configPath}; copy discord.config.example.json and fill in server IDs.`);
	const env = { ...parseDiscordEnv(join(rootDir, ".env")) };
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	const config = validateDiscordConfig(JSON.parse(readFileSync(configPath, "utf8")), rootDir);
	for (const persona of config.personas)
		if (!env[persona.token_env]) throw new Error(`Missing bot token environment variable: ${persona.token_env}`);
	if (!env[config.routingSecretEnv])
		throw new Error(`Missing routing secret environment variable: ${config.routingSecretEnv}`);
	if (config.voice && !env[config.voice.apiKeyEnv])
		throw new Error(`Missing voice API key environment variable: ${config.voice.apiKeyEnv}`);
	return { config, rootDir, dataDir: config.dataDir, env };
}

/** Create only a non-secret Pi model catalog. Credentials stay in the process environment. */
export function ensureDeepSeekModelsFile(agentDir: string): string {
	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) {
		mkdirSync(dirname(modelsPath), { recursive: true });
		const catalog = {
			providers: {
				deepseek: {
					baseUrl: "https://api.deepseek.com",
					api: "openai-completions",
					apiKey: "$DEEPSEEK_API_KEY",
					models: [
						{
							id: "deepseek-flash",
							name: "DeepSeek V4.1 Flash",
							reasoning: true,
							input: ["text", "image"],
							contextWindow: 65_536,
							maxTokens: 8_192,
							// USD per million tokens; documented as an estimate because provider pricing can change.
							cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
						},
					],
				},
			},
		};
		writeFileSync(modelsPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	}
	return modelsPath;
}
