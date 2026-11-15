/**
 * Composer image admission (paste/drop): signature sniffing, canonical
 * base64, the 25 MiB per-file ceiling, and the notices for rejected files.
 * Also the draft store's untrusted-read parser and the opening-entry flag
 * that lets an image-only opening carry empty text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	admitComposerImages, bytesToBase64, imageFilesOf, MAX_COMPOSER_IMAGE_BYTES, OVERSIZED_IMAGE_NOTICE,
	sniffComposerImageMime, UNSUPPORTED_IMAGE_NOTICE,
} from "../components/composer-images.ts";
import { parseComposerDraft } from "../components/draft-store.ts";
import { readOpeningPromptEntry, stashOpeningPrompt } from "../components/opening-prompt.ts";
import { IMAGE_ONLY_SESSION_TITLE, sessionTitleFor } from "../components/start-session.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode("GIF89a\u0001\u0000");
const WEBP = Uint8Array.from([...new TextEncoder().encode("RIFF"), 4, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
const BMP = Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

describe("sniffComposerImageMime", () => {
	it("recognizes PNG, JPEG, GIF and WebP by signature", () => {
		assert.equal(sniffComposerImageMime(PNG), "image/png");
		assert.equal(sniffComposerImageMime(JPEG), "image/jpeg");
		assert.equal(sniffComposerImageMime(GIF), "image/gif");
		assert.equal(sniffComposerImageMime(WEBP), "image/webp");
	});
	it("rejects BMP, SVG and empty bytes", () => {
		assert.equal(sniffComposerImageMime(BMP), null);
		assert.equal(sniffComposerImageMime(SVG), null);
		assert.equal(sniffComposerImageMime(new Uint8Array()), null);
	});
});

describe("bytesToBase64", () => {
	it("matches Node's canonical base64, including across chunk boundaries", () => {
		const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => (i * 31) & 255);
		assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
		assert.equal(bytesToBase64(PNG), Buffer.from(PNG).toString("base64"));
	});
});

describe("admitComposerImages", () => {
	it("admits supported images with their sniffed type, not the declared one", async () => {
		const lying = new File([PNG], "photo.jpg", { type: "image/jpeg" });
		const { images, notice } = await admitComposerImages([lying, new File([GIF], "a.gif", { type: "image/gif" })]);
		assert.deepEqual(images.map(image => image.mimeType), ["image/png", "image/gif"]);
		assert.equal(images[0]!.data, Buffer.from(PNG).toString("base64"));
		assert.equal(notice, "");
	});
	it("rejects unsupported formats with a notice and keeps the rest", async () => {
		const { images, notice } = await admitComposerImages([new File([BMP], "a.bmp", { type: "image/bmp" }), new File([SVG], "a.svg", { type: "image/svg+xml" }), new File([JPEG], "a.jpg", { type: "image/jpeg" })]);
		assert.deepEqual(images.map(image => image.mimeType), ["image/jpeg"]);
		assert.equal(notice, UNSUPPORTED_IMAGE_NOTICE);
	});
	it("rejects files over 25 MiB without reading them", async () => {
		let read = false;
		const huge = { size: MAX_COMPOSER_IMAGE_BYTES + 1, type: "image/png", arrayBuffer: async () => { read = true; return PNG.buffer; } } as unknown as File;
		const { images, notice } = await admitComposerImages([huge]);
		assert.deepEqual(images, []);
		assert.equal(notice, OVERSIZED_IMAGE_NOTICE);
		assert.equal(read, false);
	});
	it("imageFilesOf keeps only files that claim an image type", () => {
		const image = new File([PNG], "a.png", { type: "image/png" });
		assert.deepEqual(imageFilesOf([image, new File(["x"], "notes.pdf", { type: "application/pdf" })]), [image]);
	});
});

describe("parseComposerDraft (stored data is untrusted)", () => {
	it("keeps valid fields and strips extra keys and malformed images", () => {
		const draft = parseComposerDraft({ text: "hi", images: [{ type: "image", data: "AAAA", mimeType: "image/png", extra: 1 }, { type: "text" }, null], other: true });
		assert.deepEqual(draft, { text: "hi", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
	});
	it("rejects non-drafts", () => {
		assert.equal(parseComposerDraft(undefined), undefined);
		assert.equal(parseComposerDraft({ text: 1, images: [] }), undefined);
		assert.equal(parseComposerDraft({ text: "", images: "no" }), undefined);
	});
});

describe("opening entries with images", () => {
	function withStorage(run: () => void) {
		const store = new Map<string, string>();
		const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
			getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); },
		} });
		try { run(); } finally {
			if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
			else delete (globalThis as Record<string, unknown>).sessionStorage;
		}
	}
	it("an image-only opening may carry empty text, and only then", () => withStorage(() => {
		assert.equal(stashOpeningPrompt("c1", "", false, true), true);
		assert.deepEqual(readOpeningPromptEntry("c1"), { text: "", attempted: false, images: true });
		assert.equal(stashOpeningPrompt("c2", ""), false, "no text and no images is not an opening");
		assert.equal(readOpeningPromptEntry("c2"), undefined);
	}));
	it("text openings keep their exact old shape", () => withStorage(() => {
		assert.equal(stashOpeningPrompt("c3", "teach me", true), true);
		assert.deepEqual(readOpeningPromptEntry("c3"), { text: "teach me", attempted: true });
		assert.equal(stashOpeningPrompt("c4", "look", true, true), true);
		assert.deepEqual(readOpeningPromptEntry("c4"), { text: "look", attempted: true, images: true });
	}));
});

describe("sessionTitleFor", () => {
	it("uses the text, or the fixed title for an image-only start", () => {
		assert.equal(sessionTitleFor("  linear algebra "), "linear algebra");
		assert.equal(sessionTitleFor("   "), IMAGE_ONLY_SESSION_TITLE);
		assert.equal(IMAGE_ONLY_SESSION_TITLE, "New session");
	});
});
