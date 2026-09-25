import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DiscordCelebrationScheduler, type CelebrationTarget } from "../src/discord/celebrations.ts";

const guildA = "11111111111111111";
const guildB = "22222222222222222";
const channelA = "33333333333333333";
const channelB = "44444444444444444";
const userA = "55555555555555555";

const target = (overrides: Partial<CelebrationTarget> = {}): CelebrationTarget => ({
	guildId: guildA,
	channelId: channelA,
	personaId: "luna",
	timeZone: "Australia/Sydney",
	calendar: "both",
	...overrides,
});

function harness(
	targets: readonly CelebrationTarget[],
	options: {
		birthdays?: (guildId: string, month: number, day: number) => { userId: string; name: string }[];
		send?: (personaId: string, channelId: string, content: string, mentions: readonly string[]) => Promise<void>;
	} = {},
) {
	const db = new Database(":memory:");
	const sends: Array<{ personaId: string; channelId: string; content: string; mentions: readonly string[] }> = [];
	let listBirthdays = options.birthdays ?? (() => []);
	const send =
		options.send ??
		(async (personaId, channelId, content, mentions) => {
			sends.push({ personaId, channelId, content, mentions });
		});
	const create = () =>
		new DiscordCelebrationScheduler({
			db,
			targets,
			listBirthdays: (guild, month, day) => listBirthdays(guild, month, day),
			send,
		});
	return { db, sends, create, setBirthdays: (fn: typeof listBirthdays) => (listBirthdays = fn) };
}

describe("Discord celebration scheduler", () => {
	test("waits until 09:00 in the target zone across Sydney's DST change", async () => {
		const h = harness([target()], {
			birthdays: () => [{ userId: userA, name: "小明" }],
		});
		const scheduler = h.create();
		await scheduler.tick(new Date("2026-10-03T21:59:00Z")); // 07:59, before the DST jump
		expect(h.sends).toHaveLength(0);
		await scheduler.tick(new Date("2026-10-03T22:00:00Z")); // 09:00 after the DST jump
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.mentions).toEqual([userA]);
		expect(h.sends[0]?.content).toContain(`<@${userA}>`);
		h.db.close();
	});

	test("recognizes Chinese lunar festivals and merges New Year for both calendars", async () => {
		const h = harness([target()]);
		const scheduler = h.create();
		await scheduler.tick(new Date("2026-02-17T01:00:00Z")); // Sydney, lunar month 1 day 1
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("春节");
		await scheduler.tick(new Date("2027-02-07T01:00:00Z")); // Sydney, Lunar New Year
		expect(h.sends).toHaveLength(2);
		expect(h.sends[1]?.content).toContain("春节");
		const jan1 = harness([target()]);
		await jan1.create().tick(new Date("2027-01-01T00:00:00Z"));
		expect(jan1.sends).toHaveLength(1);
		expect(jan1.sends[0]?.content).toContain("新年快乐");
		h.db.close();
		jan1.db.close();
	});

	test("recognizes China Labour Day and Australian Boxing Day", async () => {
		const h = harness([target()]);
		const scheduler = h.create();
		await scheduler.tick(new Date("2026-05-01T00:00:00Z")); // Sydney, May 1
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("劳动节");
		await scheduler.tick(new Date("2026-12-26T00:00:00Z")); // Sydney, Boxing Day
		expect(h.sends).toHaveLength(2);
		expect(h.sends[1]?.content).toContain("Boxing Day");
		h.db.close();
	});

	test("uses official NSW Easter dates in 2026 and 2027 and deduplicates each Sydney local day", async () => {
		const h = harness([target({ calendar: "australia" })]);
		const scheduler = h.create();
		// NSW lists Good Friday on 3 April and Easter Sunday on 5 April in 2026.
		const goodFriday2026 = new Date("2026-04-03T00:00:00Z"); // 11:00 in Sydney
		await scheduler.tick(goodFriday2026);
		await scheduler.tick(goodFriday2026);
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain("Good Friday");
		await scheduler.tick(new Date("2026-04-05T00:00:00Z"));
		expect(h.sends).toHaveLength(2);
		expect(h.sends[1]?.content).toContain("Easter Sunday");

		// NSW lists Good Friday on 26 March and Easter Sunday on 28 March in 2027.
		await scheduler.tick(new Date("2027-03-26T00:00:00Z"));
		expect(h.sends).toHaveLength(3);
		expect(h.sends[2]?.content).toContain("Good Friday");
		await scheduler.tick(new Date("2027-03-28T00:00:00Z"));
		expect(h.sends).toHaveLength(4);
		expect(h.sends[3]?.content).toContain("Easter Sunday");
		h.db.close();
	});

	test("is idempotent across ticks and scheduler restarts", async () => {
		const h = harness([target()], { birthdays: () => [{ userId: userA, name: "小明" }] });
		const first = h.create();
		const now = new Date("2026-05-04T00:00:00Z");
		await first.tick(now);
		await first.tick(now);
		const restarted = h.create();
		await restarted.tick(now);
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("retries a failed delivery on the same local date", async () => {
		let attempts = 0;
		const h = harness([target()], {
			birthdays: () => [{ userId: userA, name: "小明" }],
			send: async (_persona, _channel, content, mentions) => {
				attempts++;
				if (attempts === 1) throw new Error("temporary send failure");
				h.sends.push({ personaId: "luna", channelId: channelA, content, mentions });
			},
		});
		const scheduler = h.create();
		const now = new Date("2026-05-04T00:00:00Z");
		await expect(scheduler.tick(now)).rejects.toThrow("temporary send failure");
		await scheduler.tick(now);
		expect(attempts).toBe(2);
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("recovers a stale in-flight delivery after restart", async () => {
		const h = harness([target()], { birthdays: () => [{ userId: userA, name: "小明" }] });
		const first = new Date("2026-05-04T00:00:00Z");
		const scheduler = h.create();
		h.db
			.query(
				"INSERT INTO discord_celebration_deliveries (guild_id,channel_id,persona_id,local_date,event_key,status,created_at) VALUES (?,?,?,?,?,'sending',?)",
			)
			.run(guildA, channelA, "luna", "2026-05-04", `birthday:${userA}`, first.getTime());
		await scheduler.tick(first);
		expect(h.sends).toHaveLength(0);
		await h.create().tick(new Date(first.getTime() + 31 * 60_000));
		expect(h.sends).toHaveLength(1);
		h.db.close();
	});

	test("celebrates February 29 birthdays on February 28 in other years", async () => {
		const h = harness([target()], {
			birthdays: (_guild, month, day) => (month === 2 && day === 29 ? [{ userId: userA, name: "小明" }] : []),
		});
		await h.create().tick(new Date("2027-02-28T01:00:00Z"));
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.content).toContain(`<@${userA}>`);
		h.db.close();
	});

	test("isolates deliveries and birthday lookup by guild target", async () => {
		const h = harness([target(), target({ guildId: guildB, channelId: channelB, personaId: "luna-b" })], {
			birthdays: (guild) => (guild === guildA ? [{ userId: userA, name: "小明" }] : []),
		});
		await h.create().tick(new Date("2026-05-04T00:00:00Z"));
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.channelId).toBe(channelA);
		expect(h.sends[0]?.personaId).toBe("luna");
		h.db.close();
	});
});
