import type { Database } from "bun:sqlite";

export interface CelebrationTarget {
	guildId: string;
	channelId: string;
	personaId: string;
	timeZone: string;
	calendar: "china" | "australia" | "both";
}

export interface BirthdayMember {
	userId: string;
	name: string;
}

export interface DiscordCelebrationSchedulerOptions {
	db: Database;
	targets: readonly CelebrationTarget[];
	listBirthdays: (guildId: string, month: number, day: number) => readonly BirthdayMember[];
	send: (personaId: string, channelId: string, content: string, allowedMentions: readonly string[]) => Promise<void>;
	now?: () => Date;
	onError?: (error: unknown) => void;
}

interface LocalDateTime {
	year: number;
	month: number;
	day: number;
	hour: number;
}

const SNOWFLAKE = /^\d{17,20}$/;
const INTERVAL_MS = 60_000;
const STALE_SEND_MS = 30 * 60_000;

function dateTimeInZone(date: Date, timeZone: string): LocalDateTime {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour") };
}

function chineseCalendarDay(date: Date, timeZone: string): { month: string; day: number } {
	const parts = new Intl.DateTimeFormat("en-u-ca-chinese", {
		timeZone,
		month: "long",
		day: "numeric",
	}).formatToParts(date);
	return {
		month: parts.find((part) => part.type === "month")?.value ?? "",
		day: Number(parts.find((part) => part.type === "day")?.value),
	};
}

/** Gregorian computus: returns the Western Easter Sunday date for the given year. */
function easterSunday(year: number): { month: number; day: number } {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const value = h + l - 7 * m + 114;
	return { month: Math.floor(value / 31), day: (value % 31) + 1 };
}

function holidayOn(
	date: Date,
	local: LocalDateTime,
	timeZone: string,
	calendar: CelebrationTarget["calendar"],
): string[] {
	const found: string[] = [];
	if (calendar === "china" || calendar === "both") {
		if (local.month === 1 && local.day === 1) found.push("元旦");
		if (local.month === 5 && local.day === 1) found.push("劳动节");
		const lunar = chineseCalendarDay(date, timeZone);
		// Intl marks leap months with a distinct month name (for example "Fifth Monthbis").
		// Exact month names deliberately exclude those leap months.
		if (lunar.month === "First Month" && lunar.day === 1) found.push("春节");
		if (lunar.month === "Fifth Month" && lunar.day === 5) found.push("端午节");
		if (lunar.month === "Eighth Month" && lunar.day === 15) found.push("中秋节");
		if (local.month === 10 && local.day === 1) found.push("国庆节");
	}
	if (calendar === "australia" || calendar === "both") {
		if (local.month === 1 && local.day === 1) {
			if (!found.includes("元旦")) found.push("元旦");
		}
		if (local.month === 1 && local.day === 26) found.push("Australia Day");
		if (local.month === 4 && local.day === 25) found.push("ANZAC Day");
		if (local.month === 12 && local.day === 25) found.push("圣诞节");
		if (local.month === 12 && local.day === 26) found.push("Boxing Day");
		const easter = easterSunday(local.year);
		const easterDate = new Date(Date.UTC(local.year, easter.month - 1, easter.day));
		const goodFridayDate = new Date(easterDate.getTime() - 2 * 24 * 60 * 60 * 1_000);
		if (local.month === goodFridayDate.getUTCMonth() + 1 && local.day === goodFridayDate.getUTCDate())
			found.push("Good Friday");
		if (local.month === easter.month && local.day === easter.day) found.push("Easter Sunday");
	}
	return found;
}

function birthdayGreeting(name: string): string {
	const safeName = name
		.replace(/[\r\n]/g, " ")
		.trim()
		.slice(0, 80);
	return safeName
		? `🎂 <@birthday> ${safeName}生日快乐！祝你新的一岁顺顺利利、每天开心。`
		: "🎂 <@birthday> 生日快乐！祝你新的一岁顺顺利利、每天开心。";
}

/**
 * Sends one birthday greeting per member and one greeting per holiday and target,
 * once local time is at or after 09:00. Delivery claims live in SQLite so a
 * completed message is never emitted again after restart.
 */
export class DiscordCelebrationScheduler {
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = true;
	private running: Promise<void> | undefined;
	private readonly now: () => Date;

	constructor(private readonly options: DiscordCelebrationSchedulerOptions) {
		this.now = options.now ?? (() => new Date());
		for (const target of options.targets) {
			// Fail during startup on a misspelled zone, not on the first birthday.
			new Intl.DateTimeFormat("en", { timeZone: target.timeZone });
		}
		options.db.exec(`
			CREATE TABLE IF NOT EXISTS discord_celebration_deliveries (
				guild_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				persona_id TEXT NOT NULL,
				local_date TEXT NOT NULL,
				event_key TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('sending', 'sent')),
				created_at INTEGER NOT NULL,
				sent_at INTEGER,
				PRIMARY KEY (guild_id, channel_id, persona_id, local_date, event_key)
			);
		`);
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		const run = () => void this.tick().catch((error) => this.options.onError?.(error));
		run();
		this.timer = setInterval(run, INTERVAL_MS);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.running;
	}

	async tick(now: Date = this.now()): Promise<void> {
		if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");
		if (this.running) return this.running;
		const task = this.deliverForDate(now);
		this.running = task;
		try {
			await task;
		} finally {
			if (this.running === task) this.running = undefined;
		}
	}

	private async deliverForDate(now: Date): Promise<void> {
		for (const target of this.options.targets) {
			const local = dateTimeInZone(now, target.timeZone);
			if (local.hour < 9) continue;
			const localDate = `${local.year.toString().padStart(4, "0")}-${local.month.toString().padStart(2, "0")}-${local.day.toString().padStart(2, "0")}`;
			const birthdays = [...this.options.listBirthdays(target.guildId, local.month, local.day)];
			// A February 29 birthday is celebrated on February 28 in non-leap years.
			if (local.month === 2 && local.day === 28 && !isLeapYear(local.year))
				birthdays.push(...this.options.listBirthdays(target.guildId, 2, 29));
			const seenUsers = new Set<string>();
			for (const member of birthdays) {
				if (!SNOWFLAKE.test(member.userId) || seenUsers.has(member.userId)) continue;
				seenUsers.add(member.userId);
				const text = birthdayGreeting(member.name).replace("<@birthday>", `<@${member.userId}>`);
				await this.sendOnce(target, localDate, `birthday:${member.userId}`, text, [member.userId], now);
			}
			for (const holiday of holidayOn(now, local, target.timeZone, target.calendar)) {
				await this.sendOnce(
					target,
					localDate,
					`holiday:${holiday}`,
					holiday === "元旦"
						? "🎉 新年快乐！愿大家新的一年平安顺心、万事顺意。"
						: `🎉 今天是${holiday}，祝大家节日愉快、平安顺心！`,
					[],
					now,
				);
			}
		}
	}

	private async sendOnce(
		target: CelebrationTarget,
		localDate: string,
		eventKey: string,
		content: string,
		allowedMentions: readonly string[],
		now: Date,
	): Promise<void> {
		const claimed = this.options.db
			.query(`
				INSERT INTO discord_celebration_deliveries
					(guild_id, channel_id, persona_id, local_date, event_key, status, created_at)
				VALUES (?, ?, ?, ?, ?, 'sending', ?)
				ON CONFLICT (guild_id, channel_id, persona_id, local_date, event_key) DO UPDATE SET
					created_at = excluded.created_at
				WHERE discord_celebration_deliveries.status = 'sending'
					AND discord_celebration_deliveries.created_at < ?
			`)
			.run(
				target.guildId,
				target.channelId,
				target.personaId,
				localDate,
				eventKey,
				now.getTime(),
				now.getTime() - STALE_SEND_MS,
			);
		if (claimed.changes === 0) return;
		try {
			await this.options.send(target.personaId, target.channelId, content, allowedMentions);
			this.options.db
				.query(`
					UPDATE discord_celebration_deliveries SET status = 'sent', sent_at = ?
					WHERE guild_id = ? AND channel_id = ? AND persona_id = ? AND local_date = ? AND event_key = ?
				`)
				.run(now.getTime(), target.guildId, target.channelId, target.personaId, localDate, eventKey);
		} catch (error) {
			this.options.db
				.query(`
					DELETE FROM discord_celebration_deliveries
					WHERE guild_id = ? AND channel_id = ? AND persona_id = ? AND local_date = ? AND event_key = ? AND status = 'sending'
				`)
				.run(target.guildId, target.channelId, target.personaId, localDate, eventKey);
			throw error;
		}
	}
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
