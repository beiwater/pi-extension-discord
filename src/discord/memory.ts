import type { Database } from "bun:sqlite";

/** The message fields used by the Discord memory layer. */
export interface DiscordMemoryMessage {
	guildId: string;
	channelId: string;
	threadId?: string | null;
	messageId: string;
	authorId: string;
	authorName: string;
	username?: string | null;
	isBot: boolean;
	content: string;
	mentionedUserIds?: readonly string[];
	replyToMessageId?: string | null;
	replyToAuthorId?: string | null;
	timestamp?: number;
}

export interface DiscordMemberFactInput {
	guildId: string;
	memberId: string;
	key: string;
	value: string;
	sourceChannelId: string;
	sourceMessageId: string;
	observedAt?: number;
}

export interface DiscordMemberProfile {
	guildId: string;
	userId: string;
	name: string;
	firstSeenAt: number;
	lastSeenAt: number;
	messageCount: number;
	birthday: { month: number; day: number } | null;
	facts: Array<{ key: string; value: string; updatedAt: number }>;
	relationships: Array<{ userId: string; name: string; type: string; count: number }>;
}

type ProfileRow = {
	guild_id: string;
	user_id: string;
	name: string;
	first_seen_at: number;
	last_seen_at: number;
	message_count: number;
	birthday_month: number | null;
	birthday_day: number | null;
};

const MAX_FACT_KEY_LENGTH = 32;
const MAX_FACT_VALUE_LENGTH = 300;
const MAX_RECALL_MEMBERS = 20;
const MAX_RECALL_CHARS = 2_000;
const ALLOWED_FACT_KEYS = new Set([
	"preference",
	"interest",
	"role",
	"project",
	"timezone",
	"language",
	"goal",
	"note",
]);
const SENSITIVE_KEY = /password|secret|token|credential|medical|health|religion|politic|sexual|address|phone|email/i;
const UNSAFE_FACT_VALUE =
	/[\r\n\u0000-\u001f]|(?:ignore|disregard).{0,24}(?:instructions|prompt)|(?:忽略|无视).{0,12}(?:指令|提示词)|(?:api[_ -]?key|password|token|secret)\s*[:=]|\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,})\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS discord_memory_profiles (
		guild_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		preferred_name INTEGER NOT NULL DEFAULT 0,
		first_seen_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		message_count INTEGER NOT NULL DEFAULT 0,
		birthday_month INTEGER,
		birthday_day INTEGER,
		birthday_source_channel_id TEXT,
		birthday_source_message_id TEXT,
		birthday_updated_at INTEGER,
		PRIMARY KEY (guild_id, user_id),
		CHECK ((birthday_month IS NULL AND birthday_day IS NULL) OR (birthday_month BETWEEN 1 AND 12 AND birthday_day BETWEEN 1 AND 31))
	);
	CREATE TABLE IF NOT EXISTS discord_memory_facts (
		guild_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		fact_key TEXT NOT NULL,
		value TEXT NOT NULL,
		source_channel_id TEXT NOT NULL,
		source_message_id TEXT NOT NULL,
		observed_at INTEGER NOT NULL,
		PRIMARY KEY (guild_id, user_id, fact_key)
	);
	CREATE TABLE IF NOT EXISTS discord_memory_relationships (
		guild_id TEXT NOT NULL,
		member_a TEXT NOT NULL,
		member_b TEXT NOT NULL,
		relation_type TEXT NOT NULL,
		occurrence_count INTEGER NOT NULL DEFAULT 1,
		source_channel_id TEXT NOT NULL,
		source_message_id TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (guild_id, member_a, member_b, relation_type),
		CHECK (member_a < member_b)
	);
	CREATE TABLE IF NOT EXISTS discord_memory_observed_messages (
		guild_id TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		PRIMARY KEY (guild_id, channel_id, message_id)
	);
	CREATE TABLE IF NOT EXISTS discord_memory_opt_out (
		guild_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		opted_out_at INTEGER NOT NULL,
		PRIMARY KEY (guild_id, user_id)
	);
`;

/** Small, guild-scoped durable member memory for Discord. */
export class DiscordMemberMemory {
	private readonly db: Database;

	constructor(db: Database) {
		this.db = db;
		db.exec(SCHEMA);
	}

	/** Record one message once, update profile activity, and maintain evidenced social edges. */
	observe(message: DiscordMemoryMessage, botUserIds: ReadonlySet<string> = new Set()): void {
		if (message.isBot || botUserIds.has(message.authorId)) return;
		const at = finiteTimestamp(message.timestamp);
		this.db.transaction(() => {
			const inserted =
				this.db
					.query(
						"INSERT OR IGNORE INTO discord_memory_observed_messages (guild_id, channel_id, message_id) VALUES (?, ?, ?)",
					)
					.run(message.guildId, message.channelId, message.messageId).changes > 0;
			if (!inserted) return;
			if (this.isOptedOut(message.guildId, message.authorId)) return;
			this.upsertProfile(message.guildId, message.authorId, message.authorName, at);
			const statedName = extractOwnName(message.content);
			if (statedName) {
				this.db
					.query("UPDATE discord_memory_profiles SET name = ?, preferred_name = 1 WHERE guild_id = ? AND user_id = ?")
					.run(statedName, message.guildId, message.authorId);
			}
			const preference = extractOwnPreference(message.content);
			if (preference && !UNSAFE_FACT_VALUE.test(preference)) {
				this.db
					.query(`INSERT INTO discord_memory_facts
					(guild_id,user_id,fact_key,value,source_channel_id,source_message_id,observed_at)
					VALUES (?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,fact_key) DO UPDATE SET
					value=excluded.value,source_channel_id=excluded.source_channel_id,
					source_message_id=excluded.source_message_id,observed_at=excluded.observed_at`)
					.run(message.guildId, message.authorId, "preference", preference, message.channelId, message.messageId, at);
			}
			const targets = new Set(message.mentionedUserIds ?? []);
			if (message.replyToAuthorId) targets.add(message.replyToAuthorId);
			for (const targetId of targets) {
				if (targetId === message.authorId || botUserIds.has(targetId) || this.isOptedOut(message.guildId, targetId))
					continue;
				const targetName = this.lookupName(message.guildId, targetId) ?? targetId;
				this.upsertRelationship(message.guildId, message.authorId, targetId, "interaction", message, at);
				const declaration = explicitRelationship(message.content, targetId);
				if (declaration) this.upsertRelationship(message.guildId, message.authorId, targetId, declaration, message, at);
				// Names are only refreshed when a member has previously spoken in this guild.
				if (targetName !== targetId) this.upsertProfile(message.guildId, targetId, targetName, at, false);
			}
			const birthday = extractOwnBirthday(message.content);
			if (birthday)
				this.writeBirthday(
					message.guildId,
					message.authorId,
					birthday.month,
					birthday.day,
					message.channelId,
					message.messageId,
					at,
				);
		})();
	}

	rememberFact(input: DiscordMemberFactInput): void {
		const key = input.key.trim().toLowerCase();
		const value = input.value.trim();
		if (!ALLOWED_FACT_KEYS.has(key) || key.length > MAX_FACT_KEY_LENGTH || SENSITIVE_KEY.test(key))
			throw new Error("invalid_memory_fact_key");
		if (!value || value.length > MAX_FACT_VALUE_LENGTH || UNSAFE_FACT_VALUE.test(value))
			throw new Error("invalid_memory_fact_value");
		const at = finiteTimestamp(input.observedAt);
		this.db.transaction(() => {
			if (this.isOptedOut(input.guildId, input.memberId)) throw new Error("memory_opted_out");
			this.upsertProfile(
				input.guildId,
				input.memberId,
				this.lookupName(input.guildId, input.memberId) ?? input.memberId,
				at,
				false,
			);
			this.db
				.query(`
				INSERT INTO discord_memory_facts
				(guild_id, user_id, fact_key, value, source_channel_id, source_message_id, observed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(guild_id, user_id, fact_key) DO UPDATE SET
				value=excluded.value, source_channel_id=excluded.source_channel_id,
				source_message_id=excluded.source_message_id, observed_at=excluded.observed_at
			`)
				.run(input.guildId, input.memberId, key, value, input.sourceChannelId, input.sourceMessageId, at);
		})();
	}

	/** Return a compact, bounded memory snippet; every lookup is constrained to this guild. */
	recall(guildId: string, memberIds: readonly string[]): string {
		const ids = [...new Set(memberIds)].slice(0, MAX_RECALL_MEMBERS).filter((id) => !this.isOptedOut(guildId, id));
		if (!ids.length) return "";
		const marks = ids.map(() => "?").join(",");
		const profiles = this.db
			.query(`
			SELECT user_id, name, birthday_month, birthday_day FROM discord_memory_profiles
			WHERE guild_id = ? AND user_id IN (${marks}) ORDER BY last_seen_at DESC LIMIT ${MAX_RECALL_MEMBERS}
		`)
			.all(guildId, ...ids) as Array<{
			user_id: string;
			name: string;
			birthday_month: number | null;
			birthday_day: number | null;
		}>;
		const lines: string[] = [];
		for (const profile of profiles) {
			const facts = this.db
				.query(
					`SELECT fact_key, value FROM discord_memory_facts WHERE guild_id = ? AND user_id = ? ORDER BY observed_at DESC LIMIT 5`,
				)
				.all(guildId, profile.user_id) as Array<{ fact_key: string; value: string }>;
			const rels = this.db
				.query(`
				SELECT r.member_a, r.member_b, r.relation_type, p.name
				FROM discord_memory_relationships r
				LEFT JOIN discord_memory_profiles p ON p.guild_id = r.guild_id AND p.user_id = CASE WHEN r.member_a = ? THEN r.member_b ELSE r.member_a END
				WHERE r.guild_id = ? AND (r.member_a = ? OR r.member_b = ?) ORDER BY r.occurrence_count DESC LIMIT 4
			`)
				.all(profile.user_id, guildId, profile.user_id, profile.user_id) as Array<{
				member_a: string;
				member_b: string;
				relation_type: string;
				name: string | null;
			}>;
			const details = facts.map((fact) => `${fact.fact_key}: ${fact.value}`);
			if (profile.birthday_month && profile.birthday_day)
				details.push(`生日: ${profile.birthday_month}月${profile.birthday_day}日`);
			for (const rel of rels)
				details.push(
					`${rel.relation_type}: ${rel.name ?? (rel.member_a === profile.user_id ? rel.member_b : rel.member_a)}`,
				);
			if (details.length) lines.push(`${profile.name}：${details.join("；")}`);
		}
		return truncate(lines.join("\n"), MAX_RECALL_CHARS);
	}

	getProfile(guildId: string, userId: string): DiscordMemberProfile | null {
		if (this.isOptedOut(guildId, userId)) return null;
		const row = this.db
			.query("SELECT * FROM discord_memory_profiles WHERE guild_id = ? AND user_id = ?")
			.get(guildId, userId) as ProfileRow | null;
		if (!row) return null;
		const facts = this.db
			.query(
				"SELECT fact_key, value, observed_at FROM discord_memory_facts WHERE guild_id = ? AND user_id = ? ORDER BY fact_key",
			)
			.all(guildId, userId) as Array<{ fact_key: string; value: string; observed_at: number }>;
		const relationships = this.db
			.query(`
			SELECT r.member_a, r.member_b, r.relation_type, r.occurrence_count, p.name
			FROM discord_memory_relationships r
			LEFT JOIN discord_memory_profiles p ON p.guild_id = r.guild_id AND p.user_id = CASE WHEN r.member_a = ? THEN r.member_b ELSE r.member_a END
			WHERE r.guild_id = ? AND (r.member_a = ? OR r.member_b = ?)
		`)
			.all(userId, guildId, userId, userId) as Array<{
			member_a: string;
			member_b: string;
			relation_type: string;
			occurrence_count: number;
			name: string | null;
		}>;
		return {
			guildId: row.guild_id,
			userId: row.user_id,
			name: row.name,
			firstSeenAt: row.first_seen_at,
			lastSeenAt: row.last_seen_at,
			messageCount: row.message_count,
			birthday: row.birthday_month && row.birthday_day ? { month: row.birthday_month, day: row.birthday_day } : null,
			facts: facts.map((fact) => ({ key: fact.fact_key, value: fact.value, updatedAt: fact.observed_at })),
			relationships: relationships.map((rel) => ({
				userId: rel.member_a === userId ? rel.member_b : rel.member_a,
				name: rel.name ?? (rel.member_a === userId ? rel.member_b : rel.member_a),
				type: rel.relation_type,
				count: rel.occurrence_count,
			})),
		};
	}

	setBirthday(
		guildId: string,
		userId: string,
		month: number,
		day: number,
		sourceChannelId?: string,
		sourceMessageId?: string,
	): void {
		assertBirthday(month, day);
		this.db.transaction(() => {
			if (this.isOptedOut(guildId, userId)) throw new Error("memory_opted_out");
			const name = this.lookupName(guildId, userId) ?? userId;
			this.upsertProfile(guildId, userId, name, Date.now(), false);
			this.writeBirthday(guildId, userId, month, day, sourceChannelId ?? "", sourceMessageId ?? "", Date.now());
		})();
	}

	clearBirthday(guildId: string, userId: string): void {
		this.db
			.query(`UPDATE discord_memory_profiles SET birthday_month = NULL, birthday_day = NULL,
			birthday_source_channel_id = NULL, birthday_source_message_id = NULL, birthday_updated_at = NULL
			WHERE guild_id = ? AND user_id = ?`)
			.run(guildId, userId);
	}

	listBirthdays(guildId: string, month: number, day: number): { userId: string; name: string }[] {
		assertBirthday(month, day);
		return this.db
			.query(`SELECT p.user_id AS userId, p.name FROM discord_memory_profiles p
			WHERE p.guild_id = ? AND p.birthday_month = ? AND p.birthday_day = ?
			AND NOT EXISTS (SELECT 1 FROM discord_memory_opt_out o WHERE o.guild_id = p.guild_id AND o.user_id = p.user_id)
			ORDER BY p.name, p.user_id`)
			.all(guildId, month, day) as Array<{ userId: string; name: string }>;
	}

	forgetMember(guildId: string, userId: string): void {
		this.db.transaction(() => {
			this.db.query("DELETE FROM discord_memory_profiles WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
			this.db.query("DELETE FROM discord_memory_facts WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
			this.db
				.query("DELETE FROM discord_memory_relationships WHERE guild_id = ? AND (member_a = ? OR member_b = ?)")
				.run(guildId, userId, userId);
			this.db
				.query(
					"INSERT INTO discord_memory_opt_out (guild_id,user_id,opted_out_at) VALUES (?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET opted_out_at=excluded.opted_out_at",
				)
				.run(guildId, userId, Date.now());
		})();
	}

	enableMember(guildId: string, userId: string): void {
		this.db.query("DELETE FROM discord_memory_opt_out WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
	}

	private isOptedOut(guildId: string, userId: string): boolean {
		return !!this.db
			.query("SELECT 1 AS found FROM discord_memory_opt_out WHERE guild_id = ? AND user_id = ?")
			.get(guildId, userId);
	}

	private lookupName(guildId: string, userId: string): string | null {
		const row = this.db
			.query("SELECT name FROM discord_memory_profiles WHERE guild_id = ? AND user_id = ?")
			.get(guildId, userId) as { name: string } | null;
		return row?.name ?? null;
	}

	private upsertProfile(guildId: string, userId: string, name: string, at: number, countMessage = true): void {
		const clean = cleanName(name) || userId;
		this.db
			.query(`INSERT INTO discord_memory_profiles (guild_id,user_id,name,first_seen_at,last_seen_at,message_count)
			VALUES (?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET
			name=CASE WHEN discord_memory_profiles.preferred_name = 1 THEN discord_memory_profiles.name ELSE excluded.name END,
			last_seen_at=MAX(discord_memory_profiles.last_seen_at,excluded.last_seen_at),
			message_count=discord_memory_profiles.message_count + excluded.message_count`)
			.run(guildId, userId, clean, at, at, countMessage ? 1 : 0);
	}

	private upsertRelationship(
		guildId: string,
		left: string,
		right: string,
		type: string,
		message: DiscordMemoryMessage,
		at: number,
	): void {
		const [a, b] = left < right ? [left, right] : [right, left];
		this.db
			.query(`INSERT INTO discord_memory_relationships
			(guild_id,member_a,member_b,relation_type,occurrence_count,source_channel_id,source_message_id,updated_at)
			VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(guild_id,member_a,member_b,relation_type) DO UPDATE SET
			occurrence_count=discord_memory_relationships.occurrence_count+1,
			source_channel_id=excluded.source_channel_id, source_message_id=excluded.source_message_id, updated_at=excluded.updated_at`)
			.run(guildId, a, b, type, message.channelId, message.messageId, at);
	}

	private writeBirthday(
		guildId: string,
		userId: string,
		month: number,
		day: number,
		channelId: string,
		messageId: string,
		at: number,
	): void {
		this.db
			.query(`UPDATE discord_memory_profiles SET birthday_month=?, birthday_day=?,
			birthday_source_channel_id=?, birthday_source_message_id=?, birthday_updated_at=?
			WHERE guild_id=? AND user_id=?`)
			.run(month, day, channelId, messageId, at, guildId, userId);
	}
}

function cleanName(name: string): string {
	return name
		.replace(/[\r\n\u0000-\u001f]/g, " ")
		.trim()
		.slice(0, 80);
}

function finiteTimestamp(value?: number): number {
	return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : Date.now();
}

function assertBirthday(month: number, day: number): void {
	const max = month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
	if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > max)
		throw new Error("invalid_birthday");
}

function extractOwnBirthday(text: string): { month: number; day: number } | null {
	const value = text.trim();
	const chinese = value.match(
		/^(?:我(?:的)?生日(?:是|在)?|本人生日(?:是|在)?)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号|號)?(?:[。.!！,，\s]|$)/i,
	);
	if (chinese) return validBirthday(Number(chinese[1]), Number(chinese[2]));
	const english = value.match(
		/^(?:my birthday is|i was born on|i celebrate my birthday on)\s+(?:([A-Za-z]+)\s+(\d{1,2})|(\d{1,2})[/-](\d{1,2}))(?:[,.!\s]|$)/i,
	);
	if (!english) return null;
	if (english[1]) {
		const month = monthNumber(english[1]);
		return month ? validBirthday(month, Number(english[2])) : null;
	}
	return validBirthday(Number(english[3]), Number(english[4]));
}

function extractOwnName(text: string): string | null {
	const value = text.trim();
	if (/[?？]$/.test(value) || /吗$/.test(value)) return null;
	const match = value.match(
		/^(?:我(?:叫|的名字是)|请叫我|call me|my name is)\s*([^，。,.!！?？\n]{1,40})(?:[，。,.!！?？\s]|$)/i,
	);
	if (!match) return null;
	const name = cleanName(match[1] ?? "");
	return name && !SENSITIVE_KEY.test(name) ? name : null;
}

function extractOwnPreference(text: string): string | null {
	const valueText = text.trim();
	const chinese = valueText.match(/^(?:我(?:很)?喜欢|我最喜欢|我偏好)\s*(.{1,200})$/);
	const english = valueText.match(/^i\s+(?:really\s+)?(?:like|love|prefer)\s+(.{1,200})$/i);
	const match = chinese ?? english;
	if (!match) return null;
	const value = (match[1] ?? "").replace(/[。.!！?？]+$/, "").trim();
	if (!value || value.length > 200 || /[?？]$/.test(text.trim()) || /吗$/.test(value) || SENSITIVE_KEY.test(value))
		return null;
	return value;
}

function monthNumber(value: string): number | null {
	const months = [
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
	];
	const index = months.findIndex((month) => month.startsWith(value.toLowerCase()));
	return index < 0 ? null : index + 1;
}

function validBirthday(month: number, day: number): { month: number; day: number } | null {
	try {
		assertBirthday(month, day);
		return { month, day };
	} catch {
		return null;
	}
}

function explicitRelationship(text: string, targetId: string): string | null {
	if (!text.includes(`<@${targetId}>`) && !text.includes(`<@!${targetId}>`)) return null;
	if (/(?:是|就是)(?:我|本人)?的?(?:好)?朋友|my\s+(?:good\s+)?friend/i.test(text)) return "friend";
	if (/(?:是|就是)(?:我|本人)?的?同学|my\s+classmate/i.test(text)) return "classmate";
	return null;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
