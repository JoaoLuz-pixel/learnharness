/**
 * Durable device-only state (owner, 2026-11-16): the desktop page's origin
 * changes every launch, so "Don't ask again", drafts and the keyboard map
 * must live in the app's files, not browser storage.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-device-test-"));
process.env.LH_DEVICE_DIR = dir;
const store = await import("../src/server/device-local.ts");
const { parseGeneralSettingsBody } = await import("../src/server/settings-body.ts");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete (globalThis as Record<string, unknown>).localStorage; });

describe("device-only store", () => {
	it("stores only allowlisted keys, inside the device folder", () => {
		assert.equal(store.deviceDocumentPath("keymap"), path.join(dir, "keymap.json"));
		assert.equal(store.deviceDocumentPath("chat:chat_abc_123"), path.join(dir, "drafts", "chat__chat_abc_123.json"));
		assert.equal(store.deviceDocumentPath("home:practice"), path.join(dir, "drafts", "home__practice.json"));
		for (const bad of ["../settings", "chat:../../x", "chat:a/b", "new:other", "auth", "", "keymap/../x"]) assert.equal(store.deviceDocumentPath(bad), null, bad);
	});
	it("round-trips JSON documents, refuses non-JSON and oversize, deletes idempotently", () => {
		store.writeDeviceDocument("chat:c1", JSON.stringify({ text: "hi", images: [] }));
		assert.deepEqual(JSON.parse(store.readDeviceDocument("chat:c1")!), { text: "hi", images: [] });
		assert.throws(() => store.writeDeviceDocument("chat:c1", "not json"));
		assert.throws(() => store.writeDeviceDocument("chat:c1", JSON.stringify("x".repeat(store.MAX_DEVICE_DOCUMENT_BYTES))), /too large/);
		store.deleteDeviceDocument("chat:c1");
		store.deleteDeviceDocument("chat:c1");
		assert.equal(store.readDeviceDocument("chat:c1"), null);
		assert.throws(() => store.readDeviceDocument("../x"), /Unknown/);
	});
});

describe("general.confirmPauseQuestion", () => {
	it("is a strict boolean in the general section", () => {
		assert.deepEqual(parseGeneralSettingsBody({ autoUpdate: true, confirmPauseQuestion: false }), { ok: true, settings: { autoUpdate: true, confirmPauseQuestion: false } });
		assert.equal(parseGeneralSettingsBody({ confirmPauseQuestion: "no" }).ok, false);
	});
});

describe("pause confirmation lives in settings, not browser storage", () => {
	it("skips the dialog once settings say so, and writes the whole general section", async () => {
		const { pauseConfirmed, rememberPauseConfirmed } = await import("../components/pause-question-dialog.tsx");
		const puts: unknown[] = [];
		let general: Record<string, unknown> = { autoUpdate: false };
		globalThis.fetch = (async (input: string, init?: RequestInit) => {
			if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); general = JSON.parse(String(init.body)); return new Response(null, { status: 204 }); }
			return Response.json({ settings: { general } });
		}) as typeof fetch;
		assert.equal(await pauseConfirmed(), false, "asks by default");
		await rememberPauseConfirmed();
		assert.deepEqual(puts, [{ autoUpdate: false, confirmPauseQuestion: false }], "other general settings preserved");
		assert.equal(await pauseConfirmed(), true, "never asks again, whatever the page origin");
	});
	it("migrates a legacy browser flag into settings once", async () => {
		const { pauseConfirmed } = await import("../components/pause-question-dialog.tsx");
		const items = new Map([["lh.pauseQuestion.confirmed", "true"]]);
		(globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => items.get(k) ?? null, removeItem: (k: string) => items.delete(k), setItem: () => {} };
		const puts: unknown[] = [];
		globalThis.fetch = (async (_input: string, init?: RequestInit) => {
			if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
			return Response.json({ settings: { general: {} } });
		}) as typeof fetch;
		assert.equal(await pauseConfirmed(), true);
		assert.deepEqual(puts, [{ confirmPauseQuestion: false }]);
		assert.equal(items.has("lh.pauseQuestion.confirmed"), false, "legacy flag removed after migration");
	});
});

describe("drafts persist through the device route", () => {
	it("saves, loads, and never leaves an older copy behind when a draft is too large", async () => {
		const { loadDraft, saveDraft } = await import("../components/draft-store.ts");
		const calls: { method: string; url: string }[] = [];
		const files = new Map<string, string>();
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ method, url });
			if (method === "PUT") { files.set(url, String(init!.body)); return new Response(null, { status: 204 }); }
			if (method === "DELETE") { files.delete(url); return new Response(null, { status: 204 }); }
			return files.has(url) ? new Response(files.get(url), { status: 200 }) : new Response(null, { status: 204 });
		}) as typeof fetch;
		await saveDraft("chat:c1", { text: "keep me", images: [] });
		assert.deepEqual(await loadDraft("chat:c1"), { text: "keep me", images: [] });
		assert.equal(calls[0]!.url, "/api/device/chat%3Ac1");
		await saveDraft("chat:c1", { text: "x".repeat(26 * 1024 * 1024), images: [] });
		assert.equal(await loadDraft("chat:c1"), undefined, "the stale smaller draft was removed, not restored");
		await saveDraft("chat:c1", { text: "  ", images: [] });
		assert.equal(calls.at(-1)!.method, "DELETE", "an empty draft is a deletion");
	});
});
