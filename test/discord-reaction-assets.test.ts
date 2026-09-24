import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { resolveReactionAsset, type ReactionAssetId } from "../src/discord/core.ts";

describe("fixed Discord reaction image catalog", () => {
	test("selects only the four bundled PNG assets", () => {
		const ids: ReactionAssetId[] = ["hello", "laugh", "think", "hug"];
		for (const id of ids) {
			const asset = resolveReactionAsset(id);
			expect(asset).not.toBeNull();
			expect(basename(asset!.path)).toBe(`${id}.png`);
			expect(statSync(asset!.path).size).toBeGreaterThan(0);
			expect(readFileSync(asset!.path).subarray(0, 8)).toEqual(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			);
		}
	});

	test("rejects invented ids, traversal, and caller-supplied paths", () => {
		expect(resolveReactionAsset("../../tmp/secret.png")).toBeNull();
		expect(resolveReactionAsset("/tmp/reaction.png")).toBeNull();
		expect(resolveReactionAsset("hello.png")).toBeNull();
	});
});
