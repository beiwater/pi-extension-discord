const DEFAULT_ENDPOINT = "https://api.fish.audio/v1/tts";
const DEFAULT_MODEL = "s2.1-pro-free";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type FishAudioTtsErrorCode =
	| "missing_api_key"
	| "invalid_input"
	| "invalid_options"
	| "http_error"
	| "invalid_response"
	| "audio_too_large"
	| "timeout"
	| "network_error";

/** Safe, stable error codes; provider response bodies and credentials are never included. */
export class FishAudioTtsError extends Error {
	constructor(public readonly code: FishAudioTtsErrorCode) {
		super(`Fish Audio TTS failed: ${code}`);
		this.name = "FishAudioTtsError";
	}
}

export interface FishAudioTtsOptions {
	model?: string;
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	timeoutMs?: number;
}

async function readAudioBounded(response: Response): Promise<Uint8Array> {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (contentType.includes("application/json") || contentType.includes("text/")) {
		throw new FishAudioTtsError("invalid_response");
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
		throw new FishAudioTtsError("audio_too_large");
	}
	if (!response.body) throw new FishAudioTtsError("invalid_response");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_AUDIO_BYTES) {
				await reader.cancel();
				throw new FishAudioTtsError("audio_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (total === 0) throw new FishAudioTtsError("invalid_response");
	const audio = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		audio.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return audio;
}

/** Generate an MP3 from Fish Audio and return the binary audio for a Discord attachment. */
export async function synthesizeFishAudioTts(
	apiKey: string,
	text: string,
	referenceId: string,
	options: FishAudioTtsOptions = {},
): Promise<Uint8Array> {
	if (!apiKey.trim()) throw new FishAudioTtsError("missing_api_key");
	if (
		typeof text !== "string" ||
		!text.trim() ||
		text.length > MAX_TEXT_LENGTH ||
		typeof referenceId !== "string" ||
		!referenceId.trim() ||
		referenceId.length > 256
	) {
		throw new FishAudioTtsError("invalid_input");
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const model = options.model ?? DEFAULT_MODEL;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || !model.trim()) {
		throw new FishAudioTtsError("invalid_options");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await (options.fetch ?? fetch)(DEFAULT_ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				model,
			},
			body: JSON.stringify({ text, reference_id: referenceId, format: "mp3" }),
			signal: controller.signal,
		});
		if (!response.ok) throw new FishAudioTtsError("http_error");
		return await readAudioBounded(response);
	} catch (error) {
		if (error instanceof FishAudioTtsError) throw error;
		if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
			throw new FishAudioTtsError("timeout");
		}
		throw new FishAudioTtsError("network_error");
	} finally {
		clearTimeout(timer);
	}
}
