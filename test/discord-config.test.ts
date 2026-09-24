import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeepSeekModelsFile, parseDiscordEnv, validateDiscordConfig } from "../src/discord/config.ts";

const base = {
	guildId: "1552560014353506386",
	channelIds: ["1552560015276113962"],
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
		expect(config.guildId).toBe("1552560014353506386");
		expect(config.channelIds).toEqual(["1552560015276113962"]);
		expect(config.personas[0]?.personaPath).toBe("/private/app/personas/luna.md");
	});

	test("rejects numeric ids, missing tokens and routing probability over 100%", () => {
		expect(() => validateDiscordConfig({ ...base, guildId: 123 }, "/tmp")).toThrow(/guildId/);
		expect(() => validateDiscordConfig({ ...base, channelIds: [123] }, "/tmp")).toThrow(/channelIds/);
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
