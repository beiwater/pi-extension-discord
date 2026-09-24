import { describe, expect, test } from "bun:test";
import {
	asDiscordOutboundAttachment,
	downloadDiscordImage,
	prepareDiscordImageForPi,
	type DiscordImageMime,
} from "../src/discord/media.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const base = {
	url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
	filename: "../photo.png",
	contentType: "image/png",
};

describe("Discord image attachments", () => {
	test("downloads bounded CDN images and verifies the actual format", async () => {
		const result = await downloadDiscordImage(base, {
			fetchImpl: async () => new Response(png, { headers: { "content-length": String(png.length) } }),
		});
		expect(result).toEqual({ ok: true, bytes: png, mimeType: "image/png", filename: "photo.png" });
		if (!result.ok) throw new Error("expected image download");
		const prepared = await prepareDiscordImageForPi(result, {
			resize: async () => ({
				data: Buffer.from(png).toString("base64"),
				mimeType: "image/png",
				originalWidth: 1,
				originalHeight: 1,
				width: 1,
				height: 1,
				wasResized: false,
			}),
		});
		expect(prepared).toEqual({
			ok: true,
			image: { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
		});
	});

	test("prepares a real small PNG into Pi image content", async () => {
		const realPng = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/cpxSZwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const prepared = await prepareDiscordImageForPi({ bytes: realPng, mimeType: "image/png" });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.image.mimeType).toBe("image/png");
		const imageBytes = Buffer.from(prepared.image.data, "base64");
		expect(imageBytes.byteLength).toBeLessThanOrEqual(200_000);
		expect(Array.from(imageBytes.subarray(0, 8))).toEqual(Array.from(realPng.subarray(0, 8)));
	});

	test("rejects non-CDN URLs, non-images, declared oversize and streamed oversize bodies", async () => {
		const fetchNever = async () => {
			throw new Error("fetch must not run");
		};
		expect(
			await downloadDiscordImage({ ...base, url: "http://cdn.discordapp.com/a.png" }, { fetchImpl: fetchNever }),
		).toMatchObject({ ok: false, reason: "download_failed" });
		expect(
			await downloadDiscordImage({ ...base, url: "https://example.org/a.png" }, { fetchImpl: fetchNever }),
		).toMatchObject({ ok: false, reason: "download_failed" });
		expect(
			await downloadDiscordImage({ ...base, contentType: "application/pdf" }, { fetchImpl: fetchNever }),
		).toMatchObject({ ok: false, reason: "unsupported_type" });
		expect(await downloadDiscordImage({ ...base, size: 101 }, { maxBytes: 100, fetchImpl: fetchNever })).toMatchObject({
			ok: false,
			reason: "oversize",
		});
		expect(
			await downloadDiscordImage(base, {
				maxBytes: 10,
				fetchImpl: async () => new Response(new Uint8Array(11)),
			}),
		).toMatchObject({ ok: false, reason: "oversize" });
	});

	test("rejects HTML or malformed bytes even from the Discord CDN", async () => {
		const result = await downloadDiscordImage(base, {
			fetchImpl: async () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }),
		});
		expect(result).toEqual({ ok: false, reason: "invalid_image" });
	});

	test("adapts downloaded images to the transport attachment contract", async () => {
		const mimeType: DiscordImageMime = "image/png";
		expect(asDiscordOutboundAttachment({ bytes: png, mimeType, filename: "cat.png" })).toEqual({
			name: "cat.png",
			data: png,
			contentType: "image/png",
		});
	});
});
