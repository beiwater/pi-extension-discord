import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeepSeekModelsFile, parseDiscordEnv, validateDiscordConfig } from "../src/discord/config.ts";

const base = {
	guilds: [{ guildId: "1552560014353506386", channelIds: ["1552560015276113962"] }],
	routingSecretEnv: "DISCORD_ROUTING_SECRET",
	personas: [
		{
			id: "luna",
			name: "Luna",
			token_env: "DISCORD_LUNA_TOKEN",
			personaPath: "personas/luna.md",
			provider: "deepseek",
			model: "deepseek-flash",
			routingP: 0.65,
		},
	],
};

describe("Discord configuration", () => {
	test("keeps Discord Snowflakes as validated strings and resolves local paths", () => {
		const config = validateDiscordConfig(base, "/private/app");
		expect(config.guilds).toEqual(base.guilds);
		expect(config.personas[0]?.personaPath).toBe("/private/app/personas/luna.md");
		expect(config.personas[0]).toMatchObject({ sendReactionImages: true, voiceEnabled: true, aliases: [] });
		expect(config.personas[0]?.guildIds).toBeUndefined();
	});

	test("supports persona-specific image, voice, guild, and alias settings", () => {
		const configured = validateDiscordConfig(
			{
				...base,
				personas: [
					{
						...base.personas[0],
						sendReactionImages: false,
						voiceEnabled: false,
						guildIds: [base.guilds[0]!.guildId],
						aliases: ["Stanley", " Stanley Xu "],
					},
				],
			},
			"/private/app",
		);
		expect(configured.personas[0]).toMatchObject({
			sendReactionImages: false,
			voiceEnabled: false,
			guildIds: [base.guilds[0]!.guildId],
			aliases: ["Stanley", "Stanley Xu"],
		});
		expect(() =>
			validateDiscordConfig({ ...base, personas: [{ ...base.personas[0], sendReactionImages: "false" }] }, "/tmp"),
		).toThrow(/sendReactionImages/);
		expect(() =>
			validateDiscordConfig({ ...base, personas: [{ ...base.personas[0], guildIds: ["55555555555555555"] }] }, "/tmp"),
		).toThrow(/configured guilds/);
		expect(() =>
			validateDiscordConfig({ ...base, personas: [{ ...base.personas[0], aliases: [""] }] }, "/tmp"),
		).toThrow(/aliases/);
	});

	test("rejects numeric ids, missing tokens and routing probability over 100%", () => {
		expect(() => validateDiscordConfig({ ...base, guilds: [{ ...base.guilds[0], guildId: 123 }] }, "/tmp")).toThrow(
			/guildId/,
		);
		expect(() =>
			validateDiscordConfig({ ...base, guilds: [{ ...base.guilds[0], channelIds: [123] }] }, "/tmp"),
		).toThrow(/channelIds/);
		expect(() => validateDiscordConfig({ ...base, guilds: [] }, "/tmp")).toThrow(/guilds/);
		expect(() => validateDiscordConfig({ ...base, guilds: [base.guilds[0], base.guilds[0]] }, "/tmp")).toThrow(
			/Duplicate guild/,
		);
		expect(() =>
			validateDiscordConfig({ ...base, personas: [{ ...base.personas[0], routingP: 1.01 }] }, "/tmp"),
		).toThrow(/routingP/);
		expect(() =>
			validateDiscordConfig(
				{ ...base, personas: [...base.personas, { ...base.personas[0], id: "mio", routingP: 0.36 }] },
				"/tmp",
			),
		).toThrow(/sum/);
	});

	test("validates optional Fish Audio voice settings", () => {
		const voice = { apiKeyEnv: "FISH_AUDIO_API_KEY", referenceId: "f88f4a28bb1d4cd7b34bc191b2202eb5" };
		expect(validateDiscordConfig({ ...base, voice }, "/tmp").voice).toEqual({ ...voice, model: "s2.1-pro-free" });
		expect(() => validateDiscordConfig({ ...base, voice: { ...voice, referenceId: "invalid" } }, "/tmp")).toThrow(
			/voice.referenceId/,
		);
	});

	test("limits persona administration to configured Discord user ids", () => {
		const configured = validateDiscordConfig(
			{ ...base, personas: [{ ...base.personas[0], adminUserIds: ["55555555555555555"] }] },
			"/tmp",
		);
		expect(configured.personas[0]?.adminUserIds).toEqual(["55555555555555555"]);
		expect(() =>
			validateDiscordConfig({ ...base, personas: [{ ...base.personas[0], adminUserIds: [123] }] }, "/tmp"),
		).toThrow(/adminUserIds/);
	});

	test("celebration targets stay inside configured channels with a valid time zone", () => {
		const target = {
			guildId: base.guilds[0].guildId,
			channelId: base.guilds[0].channelIds[0],
			personaId: "luna",
			timeZone: "Australia/Sydney",
			calendar: "both",
		} as const;
		expect(validateDiscordConfig({ ...base, celebrations: [target] }, "/tmp").celebrations).toEqual([target]);
		expect(() =>
			validateDiscordConfig({ ...base, celebrations: [{ ...target, channelId: "55555555555555555" }] }, "/tmp"),
		).toThrow(/allowed guild channel/);
		expect(() =>
			validateDiscordConfig({ ...base, celebrations: [{ ...target, timeZone: "Mars/Olympus" }] }, "/tmp"),
		).toThrow(/IANA time zone/);
	});

	test("parses colon-format env without exposing values", () => {
		const root = mkdtempSync(join(tmpdir(), "discord-config-"));
		const path = join(root, ".env");
		try {
			Bun.write(path, "# credentials\nDISCORD_LUNA_TOKEN: dont-print-this\nDEEPSEEK_API_KEY: ds-secret\n");
			expect(parseDiscordEnv(path)).toEqual({ DISCORD_LUNA_TOKEN: "dont-print-this", DEEPSEEK_API_KEY: "ds-secret" });
			expect(() => {
				Bun.write(path, "bad line\n");
				parseDiscordEnv(path);
			}).toThrow(/line 1/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("writes a project-only model catalog with an environment reference and image input", () => {
		const root = mkdtempSync(join(tmpdir(), "discord-model-catalog-"));
		try {
			const path = ensureDeepSeekModelsFile(join(root, "agent"));
			const catalog = JSON.parse(readFileSync(path, "utf8"));
			expect(catalog.providers.deepseek).toMatchObject({
				baseUrl: "https://api.deepseek.com",
				apiKey: "$DEEPSEEK_API_KEY",
				models: [
					{
						id: "deepseek-flash",
						input: ["text", "image"],
						contextWindow: 65_536,
						maxTokens: 8_192,
						cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
					},
				],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
