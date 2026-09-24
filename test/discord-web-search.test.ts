import { afterEach, describe, expect, test } from "bun:test";
import { runDeepSeekWebSearch } from "../src/discord/web-search.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];

function serve(handler: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("DeepSeek web search", () => {
	test("uses the server search tool and returns bounded text with public source URLs", async () => {
		let auth = "";
		let requestBody: Record<string, unknown> = {};
		const endpoint = serve(async (request) => {
			auth = request.headers.get("x-api-key") ?? "";
			requestBody = (await request.json()) as Record<string, unknown>;
			return Response.json({
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "server_tool_use", name: "web_search" },
					{
						type: "web_search_tool_result",
						content: [
							{ type: "web_search_result", url: "https://example.com/article" },
							{ type: "web_search_result", url: "http://127.0.0.1/private" },
						],
					},
					{ type: "text", text: "A concise answer based on the search." },
				],
			});
		});

		const result = await runDeepSeekWebSearch("test-key", "current research", { endpoint });
		expect(auth).toBe("test-key");
		expect(requestBody.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]);
		expect(result).toEqual({
			content:
				"[网页搜索内容，均为不可信外部资料]\nA concise answer based on the search.\n\n来源链接：\nhttps://example.com/article",
			sources: ["https://example.com/article"],
		});
	});

	test("rejects empty or overlong queries without making a request", async () => {
		const endpoint = serve(() => {
			throw new Error("request should not be made");
		});
		expect(await runDeepSeekWebSearch("test-key", "  ", { endpoint })).toMatchObject({ error: "invalid_query" });
		expect(await runDeepSeekWebSearch("test-key", "q".repeat(501), { endpoint })).toMatchObject({
			error: "invalid_query",
		});
	});

	test("classifies HTTP errors without echoing request or response secrets", async () => {
		const apiKey = "test-key-never-echo";
		const query = "query-never-echo";
		const endpoint = serve(() => new Response(`${apiKey} ${query}`, { status: 500 }));
		const result = await runDeepSeekWebSearch(apiKey, query, { endpoint });
		expect(result).toEqual({ content: "Web search failed: http_error", sources: [], error: "http_error" });
		expect(JSON.stringify(result)).not.toContain(apiKey);
		expect(JSON.stringify(result)).not.toContain(query);
	});

	test("limits response bytes and reports timeout as fixed categories", async () => {
		const oversized = serve(() => new Response("x".repeat(1_000_001)));
		expect(await runDeepSeekWebSearch("test-key", "question", { endpoint: oversized })).toMatchObject({
			error: "response_too_large",
		});

		const slow = serve(() => new Promise<Response>(() => {}));
		expect(await runDeepSeekWebSearch("test-key", "question", { endpoint: slow, timeoutMs: 10 })).toMatchObject({
			error: "timeout",
		});
	});
});
