import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const MAX_SOUL_BYTES = 4 * 1024;
const MAX_PENDING_BYTES = 1024;
const PENDING_SEPARATOR = "\n\n<!-- pending soul note -->\n\n";
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SECRET_OR_INJECTION_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)\s*[:=]\s*\S+/i,
	/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,})\b/i,
	/ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
	/system\s+prompt/i,
	/(?:reveal|dump|print|exfiltrate)\s+(?:the\s+)?(?:secrets?|credentials?|system\s+prompt)/i,
	/\b(?:curl|wget|bash|sh|powershell|chmod|rm\s+-rf)\b/i,
	/\b(?:member|user|colleague|teammate)\s+(?:birthday|phone|email|address|medical|health|salary|password|secret)\b/i,
	/\b(?:生日|手机号|电话号码|邮箱|住址|家庭住址|病史|病情|薪资|工资|密码|密钥|私事)\b/,
	/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
	/(?:忽略|无视).{0,8}(?:之前|先前|上面).{0,8}(?:指令|规则)/,
	/(?:泄露|输出|打印).{0,8}(?:系统提示词|密钥|密码)/,
];

function assertSafeDirectory(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Soul storage path must be a real directory");
	chmodSync(path, 0o700);
}

function assertSafeFile(path: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Soul file must be a regular file");
		chmodSync(path, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

function atomicWrite(path: string, contents: string): void {
	const tempPath = join(dirname(path), `.soul-${process.pid}-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx", 0o600);
		writeFileSync(fd, contents, { encoding: "utf8" });
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		chmodSync(path, 0o600);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tempPath);
		} catch {
			// Nothing to clean up if creation did not get far enough.
		}
		throw error;
	}
}

function validateNote(text: string, maxBytes: number): string {
	if (typeof text !== "string" || !text.trim()) throw new Error("Soul text must not be empty");
	const note = text.trim();
	if (Buffer.byteLength(note, "utf8") > maxBytes) throw new Error(`Soul text exceeds ${maxBytes} bytes`);
	if (note.includes(PENDING_SEPARATOR) || SECRET_OR_INJECTION_PATTERNS.some((pattern) => pattern.test(note))) {
		throw new Error("Soul text contains secret, private member data, or instruction injection");
	}
	return note;
}

function readBoundedFile(path: string, maxBytes: number, label: string): string {
	assertSafeFile(path);
	if (!existsSync(path)) return "";
	const value = readFileSync(path, "utf8");
	if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
	return value;
}

function notesFromPending(pending: string): string[] {
	return pending
		.split(PENDING_SEPARATOR)
		.map((note) => note.trim())
		.filter(Boolean);
}

/** Private, per-persona store for stable character style and self-reflection notes. */
export class DiscordSoulStore {
	private readonly root: string;
	private readonly personas: Set<string>;

	constructor(options: { dataDir: string; personaIds: readonly string[] }) {
		if (!options.dataDir) throw new Error("dataDir is required");
		for (const id of options.personaIds) {
			if (!ID_PATTERN.test(id)) throw new Error(`Invalid persona id: ${id}`);
		}
		this.personas = new Set(options.personaIds);
		this.root = join(resolve(options.dataDir), "discord-souls");
	}

	read(personaId: string): string {
		const path = this.pathFor(personaId);
		this.ensureDirectory(personaId);
		return readBoundedFile(path, MAX_SOUL_BYTES, "Soul file");
	}

	update(personaId: string, text: string): { saved: true } {
		this.pathFor(personaId);
		const note = validateNote(text, MAX_PENDING_BYTES);
		this.ensureDirectory(personaId);
		const path = this.pendingPathFor(personaId);
		const pending = readBoundedFile(path, MAX_PENDING_BYTES, "Pending soul");
		const notes = notesFromPending(pending).map((note) => validateNote(note, MAX_PENDING_BYTES));
		if (!notes.includes(note)) {
			const next = [...notes, note].join(PENDING_SEPARATOR);
			if (Buffer.byteLength(next, "utf8") > MAX_PENDING_BYTES)
				throw new Error(`Pending soul exceeds ${MAX_PENDING_BYTES} bytes`);
			atomicWrite(path, `${next}\n`);
		}
		return { saved: true };
	}

	readPending(personaId: string): string {
		this.pathFor(personaId);
		this.ensureDirectory(personaId);
		return readBoundedFile(this.pendingPathFor(personaId), MAX_PENDING_BYTES, "Pending soul");
	}

	/** Merge staged notes into the formal soul; safe to retry after a crash before pending cleanup. */
	promotePending(personaId: string): { promoted: boolean } {
		const soulPath = this.pathFor(personaId);
		this.ensureDirectory(personaId);
		const pendingPath = this.pendingPathFor(personaId);
		const pending = readBoundedFile(pendingPath, MAX_PENDING_BYTES, "Pending soul");
		if (!pending.trim()) return { promoted: false };

		const previous = readBoundedFile(soulPath, MAX_SOUL_BYTES, "Soul file");
		const notes = notesFromPending(pending).map((note) => validateNote(note, MAX_PENDING_BYTES));
		const additions = notes.filter((note) => !previous.includes(note));
		const next = additions.length
			? `${previous.trimEnd()}${previous.trim() ? "\n\n" : ""}${additions.join("\n\n")}\n`
			: previous;
		if (Buffer.byteLength(next, "utf8") > MAX_SOUL_BYTES) throw new Error("Soul file would exceed 4 KiB");

		if (next !== previous) {
			if (previous) {
				const backupPath = join(dirname(soulPath), "soul.md.bak");
				assertSafeFile(backupPath);
				atomicWrite(backupPath, previous);
			}
			atomicWrite(soulPath, next);
		}
		assertSafeFile(pendingPath);
		unlinkSync(pendingPath);
		return { promoted: true };
	}

	private pathFor(personaId: string): string {
		if (!this.personas.has(personaId)) throw new Error("Persona is not configured for soul storage");
		return join(this.root, personaId, "soul.md");
	}

	private pendingPathFor(personaId: string): string {
		return join(this.root, personaId, "soul.pending.md");
	}

	private ensureDirectory(personaId: string): void {
		if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
		assertSafeDirectory(this.root);
		assertSafeDirectory(join(this.root, personaId));
		// realpath checks catch a symlink inserted in an ancestor between construction and use.
		const actual = realpathSync(join(this.root, personaId));
		if (actual !== join(realpathSync(this.root), personaId))
			throw new Error("Soul path escaped its configured directory");
	}
}
