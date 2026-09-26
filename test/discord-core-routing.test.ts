import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	DiscordConversationCore,
	explicitSearchQuery,
	explicitVoiceRequest,
	routeDiscordMessage,
	searchQueryForRoutedMessage,
	type DiscordInboundMessage,
	type DiscordPersona,
} from "../src/discord/core.ts";

const personas: DiscordPersona[] = [
	{
		id: "luna",
		name: "Luna",
		userId: "12345678901234567",
		personaPath: "/unused",
		provider: "deepseek",
		model: "deepseek-flash",
		routingP: 0.2,
	},
	{
		id: "mio",
		name: "Mio",
		userId: "98765432109876543",
		personaPath: "/unused",
		provider: "deepseek",
		model: "deepseek-flash",
		routingP: 0.2,
	},
];

function message(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
	return {
		guildId: "11111111111111111",
		channelId: "22222222222222222",
		messageId: "18446744073709551615",
		authorId: "33333333333333333",
		authorName: "someone",
		isBot: false,
		content: "hello",
		...overrides,
	};
}

describe("Discord conversation routing", () => {
	test("routes names and aliases only within each persona's configured guilds", () => {
		const stanley: DiscordPersona = {
			...personas[0]!,
			id: "shize",
			name: "许诗泽",
			aliases: ["Stanley", "Stanley Xu"],
			guildIds: ["11111111111111111"],
			routingP: 0,
		};
		expect(routeDiscordMessage(message({ content: "Stanley 在吗" }), [stanley], "secret")).toEqual({
			personaId: "shize",
			reason: "name",
		});
		expect(
			routeDiscordMessage(message({ guildId: "44444444444444444", content: "Stanley 在吗" }), [stanley], "secret"),
		).toEqual({
			personaId: null,
			reason: "nobody",
		});
	});

	test("prefetches an explicit lookup while ignoring a search availability question", () => {
		expect(explicitSearchQuery("<@1552581470013362197> 你查一下 HSC EAL/D Module D 是什么")).toBe(
			"你查一下 HSC EAL/D Module D 是什么",
		);
		expect(explicitSearchQuery("你查的一下 HSC EALD MODEL D 是什么然后写")).toBe(
			"你查的一下 HSC EALD MODEL D 是什么然后写",
		);
		expect(explicitSearchQuery("为什么还是没有联网搜索？")).toBeNull();
		expect(explicitSearchQuery("早上好")).toBeNull();
	});
	test("a separate mention searches the same author's immediately preceding request", () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE discord_core_messages (
				guild_id TEXT, channel_id TEXT, message_id TEXT, author_id TEXT,
				is_bot INTEGER, content TEXT, timestamp INTEGER
			)
		`);
		const insert = db.query(`
			INSERT INTO discord_core_messages
			(guild_id, channel_id, message_id, author_id, is_bot, content, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		const current = message({
			content: `<@${personas[1]!.userId}>`,
			mentionedUserIds: [personas[1]!.userId],
			timestamp: 1_000_011,
		});
		const request = "你搜一下2025年的HSCEALD题目，按这个的Model D写完整英文文章";
		insert.run(current.guildId, current.channelId, "18446744073709551614", current.authorId, 0, request, 1_000_000);
		const route = routeDiscordMessage(current, personas, "secret");
		expect(searchQueryForRoutedMessage(db, current, route)).toBe(request);

		insert.run(current.guildId, current.channelId, "18446744073709551613", "44444444444444444", 0, "hi", 1_000_010);
		expect(searchQueryForRoutedMessage(db, current, route)).toBeNull();
		insert.run(current.guildId, current.channelId, "18446744073709551612", current.authorId, 0, request, 1_000_010);
		expect(searchQueryForRoutedMessage(db, { ...current, timestamp: 1_200_011 }, route)).toBeNull();
		db.close();
	});
	test("only a configured persona admin may inspect or compact channel context", async () => {
		const db = new Database(":memory:");
		const core = new DiscordConversationCore({
			db,
			dataDir: "/unused",
			routingSecret: "secret",
			personas: [{ ...personas[1]!, adminUserIds: ["55555555555555555"] }],
			modelRuntime: {} as ModelRuntime,
			transport: { sendMessage: async () => ({ id: "12345678901234567" }) },
		});
		await expect(
			core.getContextStatus("mio", "11111111111111111", "22222222222222222", "33333333333333333"),
		).rejects.toThrow("not_persona_admin");
		await expect(
			core.compactContext("mio", "11111111111111111", "22222222222222222", "33333333333333333"),
		).rejects.toThrow("not_persona_admin");
		await core.close();
		db.close();
	});
	test("recognizes direct voice requests without turning negations into audio", () => {
		expect(explicitVoiceRequest("菲八，用语音回复我一句你好")).toBe(true);
		expect(explicitVoiceRequest("Please send a voice reply in Japanese")).toBe(true);
		expect(explicitVoiceRequest("不用语音回复，打字就行")).toBe(false);
	});
	test("routes explicit mentions before other signals", () => {
		expect(
			routeDiscordMessage(
				message({ mentionedUserIds: [personas[1]!.userId], replyToAuthorId: personas[0]!.userId }),
				personas,
				"secret",
			),
		).toEqual({ personaId: "mio", reason: "explicit" });
	});

	test("routes replies and configured names", () => {
		expect(routeDiscordMessage(message({ replyToAuthorId: personas[0]!.userId }), personas, "secret")).toEqual({
			personaId: "luna",
			reason: "reply",
		});
		expect(routeDiscordMessage(message({ content: "hey LUNA, what do you think?" }), personas, "secret")).toEqual({
			personaId: "luna",
			reason: "name",
		});
	});

	test("does not trigger on bot messages and stores string-sized IDs in route entropy", () => {
		expect(
			routeDiscordMessage(message({ isBot: true, mentionedUserIds: [personas[0]!.userId] }), personas, "secret"),
		).toEqual({ personaId: null, reason: "nobody" });
		const first = routeDiscordMessage(message(), personas, "secret");
		const replay = routeDiscordMessage(message(), personas, "secret");
		expect(replay).toEqual(first);
	});

	test("does not exceed configured cumulative probability", () => {
		const never = personas.map((persona) => ({ ...persona, routingP: 0 }));
		expect(routeDiscordMessage(message(), never, "secret")).toEqual({ personaId: null, reason: "nobody" });
	});
});
