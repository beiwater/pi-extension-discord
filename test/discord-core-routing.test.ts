import { describe, expect, test } from "bun:test";
import { routeDiscordMessage, type DiscordInboundMessage, type DiscordPersona } from "../src/discord/core.ts";

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
