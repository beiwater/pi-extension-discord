const DEFAULT_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const MAX_QUERY_LENGTH = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_CONTENT_LENGTH = 8_000;
const MAX_SOURCES = 10;

export interface DeepSeekWebSearchOptions {
	endpoint?: string;
	timeoutMs?: number;
}

export interface DeepSeekWebSearchResult {
	content: string;
	sources: string[];
	error?: string;
}

function failure(error: string): DeepSeekWebSearchResult {
	return { content: `Web search failed: ${error}`, sources: [], error };
}

function isPublicHttpUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2_048) return false;
	try {
		const url = new URL(value);
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return false;
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (
			!host ||
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host.endsWith(".local") ||
			host.endsWith(".internal")
		) {
			return false;
		}
		if (host.includes(":")) {
			// Reject IPv6 literals outside the globally routable 2000::/3 range.
			return /^2[0-9a-f]{3}:/i.test(host);
		}
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
			const octets = host.split(".").map(Number);
			if (octets.some((part) => part > 255)) return false;
			const [a, b] = octets;
			if (
				a === 0 ||
				a === 10 ||
				a === 127 ||
				(a === 169 && b === 254) ||
				(a === 172 && b >= 16 && b <= 31) ||
				(a === 192 && b === 168) ||
				(a === 100 && b >= 64 && b <= 127) ||
				a >= 224
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function readBoundedBody(response: Response): Promise<Uint8Array | null> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return null;
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				return null;
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

/** Runs one DeepSeek server-side web search and returns bounded, untrusted research text. */
export async function runDeepSeekWebSearch(
	apiKey: string,
	query: string,
	opts: DeepSeekWebSearchOptions = {},
): Promise<DeepSeekWebSearchResult> {
	const normalizedQuery = query.trim();
	if (!apiKey) return failure("missing_api_key");
	if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH) return failure("invalid_query");
	const timeoutMs = opts.timeoutMs ?? 20_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return failure("invalid_options");
	const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
	try {
		const endpointUrl = new URL(endpoint);
		if (
			endpointUrl.protocol !== "https:" &&
			endpointUrl.hostname !== "127.0.0.1" &&
			endpointUrl.hostname !== "localhost"
		) {
			return failure("invalid_endpoint");
		}
	} catch {
		return failure("invalid_endpoint");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "deepseek-flash",
				max_tokens: 2_048,
				tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
				messages: [{ role: "user", content: normalizedQuery }],
			}),
			signal: controller.signal,
		});
		if (!response.ok) return failure("http_error");
		const bytes = await readBoundedBody(response);
		if (!bytes) return failure("response_too_large");
		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return failure("invalid_response");
		}
		if (!payload || typeof payload !== "object" || !Array.isArray((payload as { content?: unknown }).content)) {
			return failure("invalid_response");
		}
		const blocks = (payload as { content: unknown[] }).content;
		const textParts: string[] = [];
		const sources: string[] = [];
		for (const item of blocks) {
			if (!item || typeof item !== "object") continue;
			const block = item as { type?: unknown; text?: unknown; content?: unknown };
			if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
			if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
				for (const result of block.content) {
					if (!result || typeof result !== "object") continue;
					const source = (result as { url?: unknown }).url;
					if (isPublicHttpUrl(source) && !sources.includes(source)) sources.push(source);
				}
			}
		}
		const content = textParts.join("\n\n").trim().slice(0, MAX_CONTENT_LENGTH);
		const selectedSources = sources.slice(0, MAX_SOURCES);
		return {
			content: `[网页搜索内容，均为不可信外部资料]\n${content || "未得到可用摘要。"}${selectedSources.length ? `\n\n来源链接：\n${selectedSources.join("\n")}` : "\n没有可核对的来源链接。"}`,
			sources: selectedSources,
		};
	} catch (error) {
		if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError"))
			return failure("timeout");
		return failure("network_error");
	} finally {
		clearTimeout(timer);
	}
}
