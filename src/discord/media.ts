/** Discord image attachment helpers shared by message ingestion and REST transport. */

import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";

export const DISCORD_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const DISCORD_PI_IMAGE_RESIZE = { maxWidth: 1024, maxHeight: 1024, maxBytes: 200_000, jpegQuality: 80 } as const;
export const DISCORD_IMAGE_HOSTS = new Set([
	"cdn.discordapp.com",
	"media.discordapp.net",
	"attachments.discordapp.net",
]);

export type DiscordImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface DiscordImageAttachment {
	url: string;
	filename?: string;
	contentType?: string | null;
	size?: number;
}

export type DiscordImageDownloadResult =
	| { ok: true; bytes: Uint8Array; mimeType: DiscordImageMime; filename: string }
	| { ok: false; reason: "unsupported_type" | "oversize" | "download_failed" | "invalid_image" };

export interface DownloadDiscordImageOptions {
	signal?: AbortSignal;
	maxBytes?: number;
	fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
}

function safeFilename(name: string | undefined, mime: DiscordImageMime): string {
	const fallback = `discord-image.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`;
	const candidate = (name ?? fallback)
		.split(/[\\/]/)
		.pop()
		?.replace(/[\r\n\0]/g, "")
		.trim();
	return candidate && candidate.length <= 120 ? candidate : fallback;
}

function detectImageMime(bytes: Uint8Array): DiscordImageMime | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "image/png";
	if (
		bytes.length >= 6 &&
		(new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF87a" ||
			new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF89a")
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
	)
		return "image/webp";
	return null;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes) throw new RangeError("oversize");
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw new RangeError("oversize");
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new RangeError("oversize");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Download only Discord CDN image attachments and verify the actual bytes before use. */
export async function downloadDiscordImage(
	attachment: DiscordImageAttachment,
	options: DownloadDiscordImageOptions = {},
): Promise<DiscordImageDownloadResult> {
	const maxBytes = options.maxBytes ?? DISCORD_IMAGE_MAX_BYTES;
	if ((attachment.size ?? 0) > maxBytes) return { ok: false, reason: "oversize" };
	if (attachment.contentType && !attachment.contentType.toLowerCase().startsWith("image/")) {
		return { ok: false, reason: "unsupported_type" };
	}
	let url: URL;
	try {
		url = new URL(attachment.url);
	} catch {
		return { ok: false, reason: "download_failed" };
	}
	if (
		url.protocol !== "https:" ||
		!DISCORD_IMAGE_HOSTS.has(url.hostname.toLowerCase()) ||
		url.username ||
		url.password
	) {
		return { ok: false, reason: "download_failed" };
	}
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			signal: options.signal,
			redirect: "error",
			headers: { accept: "image/png,image/jpeg,image/webp,image/gif" },
		});
		if (!response.ok) return { ok: false, reason: "download_failed" };
		const bytes = await readBounded(response, maxBytes);
		if (!bytes?.byteLength) return { ok: false, reason: "invalid_image" };
		const mimeType = detectImageMime(bytes);
		if (!mimeType) return { ok: false, reason: "invalid_image" };
		return { ok: true, bytes, mimeType, filename: safeFilename(attachment.filename, mimeType) };
	} catch (error) {
		return { ok: false, reason: error instanceof RangeError ? "oversize" : "download_failed" };
	}
}

export type PiImageContent = { type: "image"; data: string; mimeType: "image/jpeg" | "image/png" };

export type PiImagePreparationResult =
	| { ok: true; image: PiImageContent }
	| { ok: false; reason: "conversion_failed" | "unsupported_format" };

/** Convert provider-incompatible formats, then bound dimensions and payload size for Pi. */
export async function prepareDiscordImageForPi(
	image: Pick<DiscordImageDownloadResult & { ok: true }, "bytes" | "mimeType">,
	options: { convert?: typeof convertToPng; resize?: typeof resizeImage } = {},
): Promise<PiImagePreparationResult> {
	let bytes: Uint8Array = image.bytes;
	let mimeType: string = image.mimeType;
	if (mimeType === "image/webp" || mimeType === "image/gif") {
		const converted = await (options.convert ?? convertToPng)(Buffer.from(bytes).toString("base64"), mimeType).catch(
			() => null,
		);
		if (!converted) return { ok: false, reason: "conversion_failed" };
		bytes = new Uint8Array(Buffer.from(converted.data, "base64"));
		mimeType = converted.mimeType;
	}
	const resized = await (options.resize ?? resizeImage)(bytes, mimeType, DISCORD_PI_IMAGE_RESIZE).catch(() => null);
	if (resized) {
		bytes = new Uint8Array(Buffer.from(resized.data, "base64"));
		mimeType = resized.mimeType;
	} else if (bytes.byteLength > DISCORD_PI_IMAGE_RESIZE.maxBytes) {
		return { ok: false, reason: "conversion_failed" };
	}
	if (mimeType !== "image/png" && mimeType !== "image/jpeg") return { ok: false, reason: "unsupported_format" };
	return { ok: true, image: { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType } };
}

/** Adapter for the Discord transport's multipart attachment input. */
export function asDiscordOutboundAttachment(
	image: Pick<DiscordImageDownloadResult & { ok: true }, "bytes" | "mimeType" | "filename">,
): {
	name: string;
	data: Uint8Array;
	contentType: DiscordImageMime;
} {
	return { name: safeFilename(image.filename, image.mimeType), data: image.bytes, contentType: image.mimeType };
}
