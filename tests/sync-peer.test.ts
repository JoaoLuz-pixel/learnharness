/**
 * Device Sync's shared-folder layout (cloud folders, the built-in host,
 * protected syncs): simulated devices on one in-memory folder, including
 * cloud delays, long offline periods, conflicts, deletions and encryption.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflictId, type LocalSide } from "../src/sync/engine.ts";
import { hashBytes } from "../src/sync/merge.ts";
import { compareVv, createPeerSync, emptyPeerState, keysFit, listPeerSyncs, newPeerSyncId, PeerSyncFolder, readPeerMeta, resolvePeerConflict, runPeerCycle, collectPeerGarbage, type ContentCache, type FolderStore, type PeerConflict, type PeerState } from "../src/sync/peer.ts";
import { deriveSyncKeys, unlockSync, WrongSyncPasswordError, type SyncKeys } from "../src/sync/crypto.ts";
import { DEFAULT_SYNC_TOGGLES } from "../src/sync/scope.ts";

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

/** A cloud folder. `hidden` paths are "not copied here yet". */
class MemStore implements FolderStore {
	files = new Map<string, { bytes: Buffer; at: number }>();
	hidden = new Set<string>();
	writes = 0;
	read = async (p: string) => (this.hidden.has(p) ? null : this.files.get(p)?.bytes ?? null);
	write = async (p: string, bytes: Buffer) => { this.writes++; this.files.set(p, { bytes: Buffer.from(bytes), at: Date.now() }); };
	create = async (p: string, bytes: Buffer) => { if (!this.files.has(p)) await this.write(p, bytes); };
	remove = async (p: string) => { this.files.delete(p); };
	list = async (dir: string) => {
		const prefix = `${dir}/`, out = new Set<string>();
		for (const p of this.files.keys()) if (p.startsWith(prefix) && !this.hidden.has(p)) out.add(p.slice(prefix.length).split("/")[0]!);
		return [...out];
	};
	age = async (p: string) => { const f = this.files.get(p); return f ? Date.now() - f.at : null; };
}
class MemLocal implements LocalSide {
	files = new Map<string, Buffer>();
	list = async () => new Map([...this.files].map(([rel, bytes]) => [rel, hashBytes(bytes)]));
	read = async (rel: string) => this.files.get(rel) ?? null;
	write = async (rel: string, bytes: Buffer) => { this.files.set(rel, Buffer.from(bytes)); };
	remove = async (rel: string) => { this.files.delete(rel); };
	put(rel: string, text: string) { this.files.set(rel, Buffer.from(text)); }
	text(rel: string) { return this.files.get(rel)?.toString("utf8"); }
}
class MemCache implements ContentCache {
	m = new Map<string, Buffer>();
	get = (h: string) => this.m.get(h) ?? null;
	put = (b: Buffer) => { this.m.set(hashBytes(b), Buffer.from(b)); };
}
class Device {
	local = new MemLocal();
	cache = new MemCache();
	state: PeerState = emptyPeerState();
	conflicts: PeerConflict[] = [];
	constructor(public id: string, public name: string) {}
}

async function cycle(device: Device, folder: PeerSyncFolder) {
	const result = await runPeerCycle({ folder, local: device.local, cache: device.cache, state: device.state, deviceId: device.id, deviceName: device.name,
		toggles: DEFAULT_SYNC_TOGGLES, conflicts: device.conflicts, paused: new Set() });
	device.conflicts = device.conflicts.filter(c => !result.cleared.includes(c.id));
	device.conflicts.push(...result.conflicts);
	return result;
}
async function newSync(store: FolderStore, password?: string): Promise<{ id: string; keys: SyncKeys | null }> {
	const id = newPeerSyncId();
	const keys = await createPeerSync(store, { id, name: "Studies", createdBy: "Laptop", ...(password ? { password, kdf: FAST_KDF } : {}) });
	return { id, keys };
}
const chat = (id: string, text: string) => JSON.stringify({ id, title: id, messages: [{ role: "user", content: text }] });
const node = (id: string, phrase: string) => JSON.stringify({ id, name: phrase, statement: phrase });

describe("shared-folder sync", () => {
	it("two devices converge: sessions both ways and graph lines unioned, then nothing more is written", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		a.local.put("chats/chat_a.json", chat("a", "hello"));
		a.local.put("graph/nodes.jsonl", `${node("n1", "from laptop")}\n`);
		b.local.put("chats/chat_b.json", chat("b", "hi"));
		b.local.put("graph/nodes.jsonl", `${node("n2", "from desktop")}\n`);
		b.local.put("debug/trace.jsonl", "never synced");
		for (let i = 0; i < 3; i++) { await cycle(a, folder); await cycle(b, folder); }
		for (const d of [a, b]) {
			assert.ok(d.local.text("chats/chat_a.json") && d.local.text("chats/chat_b.json"), `${d.name} has both sessions`);
			const lines = d.local.text("graph/nodes.jsonl")!.trim().split("\n");
			assert.equal(lines.length, 2, `${d.name} has both graph nodes`);
			assert.deepEqual(d.conflicts, []);
		}
		assert.equal(a.local.text("graph/nodes.jsonl"), b.local.text("graph/nodes.jsonl"), "same ledger bytes on both");
		assert.ok(![...store.files.keys()].some(p => p.includes("debug")), "out-of-scope files never stored");
		const before = store.writes;
		await cycle(a, folder); await cycle(b, folder); await cycle(a, folder);
		assert.equal(store.writes, before, "settled: no rewrites (no ping-pong)");
	});

	it("a device offline through many edits elsewhere takes the latest, with no conflict", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_tablet1", "Tablet");
		a.local.put("chats/chat_x.json", chat("x", "v0"));
		await cycle(a, folder); await cycle(b, folder);
		for (let i = 1; i <= 60; i++) { a.local.put("chats/chat_x.json", chat("x", `v${i}`)); await cycle(a, folder); }
		const result = await cycle(b, folder);
		assert.deepEqual(result.conflicts, []);
		assert.equal(b.local.text("chats/chat_x.json"), chat("x", "v60"));
	});

	it("both devices change a session: a conflict on each; resolving on one settles both", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		a.local.put("chats/chat_x.json", chat("x", "start"));
		await cycle(a, folder); await cycle(b, folder);
		a.local.put("chats/chat_x.json", chat("x", "laptop edit"));
		b.local.put("chats/chat_x.json", chat("x", "desktop edit"));
		await cycle(a, folder); await cycle(b, folder); await cycle(a, folder);
		assert.equal(a.conflicts.length, 1); assert.equal(b.conflicts.length, 1);
		assert.equal(a.conflicts[0]!.id, conflictId("chats/chat_x.json"));
		assert.equal(a.local.text("chats/chat_x.json"), chat("x", "laptop edit"), "nothing overwritten while undecided");
		assert.equal(b.local.text("chats/chat_x.json"), chat("x", "desktop edit"));
		await resolvePeerConflict(a.conflicts[0]!, "remote", { folder, local: a.local, cache: a.cache, state: a.state, deviceId: a.id });
		a.conflicts = [];
		await cycle(a, folder); const r = await cycle(b, folder);
		assert.deepEqual(r.cleared, [conflictId("chats/chat_x.json")], "the desktop's conflict clears by itself");
		assert.deepEqual(b.conflicts, []);
		assert.equal(a.local.text("chats/chat_x.json"), chat("x", "desktop edit"));
		assert.equal(b.local.text("chats/chat_x.json"), chat("x", "desktop edit"));
	});

	it("a deletion reaches the other device; a missing snapshot never deletes anything", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		a.local.put("chats/chat_x.json", chat("x", "one")); a.local.put("chats/chat_y.json", chat("y", "two"));
		await cycle(a, folder); await cycle(b, folder);
		a.local.files.delete("chats/chat_x.json");
		await cycle(a, folder); await cycle(b, folder);
		assert.equal(b.local.text("chats/chat_x.json"), undefined, "deleted on the desktop too");
		assert.ok(b.local.text("chats/chat_y.json"));
		await folder.removeSnapshot(a.id); // the laptop left the sync
		await cycle(b, folder);
		assert.ok(b.local.text("chats/chat_y.json"), "the desktop keeps everything");
	});

	it("cloud delay: a snapshot that arrives before its content waits, then pulls", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		await cycle(b, folder);
		a.local.put("chats/chat_x.json", chat("x", "new"));
		await cycle(a, folder);
		const blob = folder.blobPath(hashBytes(Buffer.from(chat("x", "new"))));
		store.hidden.add(blob);
		const early = await cycle(b, folder);
		assert.deepEqual(early.waiting, ["chats/chat_x.json"]);
		assert.equal(b.local.text("chats/chat_x.json"), undefined);
		store.hidden.delete(blob);
		await cycle(b, folder);
		assert.equal(b.local.text("chats/chat_x.json"), chat("x", "new"));
	});

	it("a device that re-joins after Forget never loses what it changed meanwhile", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		a.local.put("chats/chat_x.json", chat("x", "start"));
		for (let i = 0; i < 2; i++) { await cycle(a, folder); await cycle(b, folder); }
		for (let i = 1; i <= 5; i++) { b.local.put("chats/chat_x.json", chat("x", `desk ${i}`)); await cycle(b, folder); }
		await cycle(a, folder);
		// Desktop forgets the sync, keeps working, then joins again with fresh state.
		b.local.put("chats/chat_x.json", chat("x", "desk offline work"));
		b.state = emptyPeerState(); b.cache = new MemCache();
		await cycle(b, folder);
		assert.equal(b.local.text("chats/chat_x.json"), chat("x", "desk offline work"), "not replaced by its own old version");
		assert.equal(b.conflicts.length, 1, "asked instead");
	});

	it("graph records: deleted on one device, added to on the other → a record conflict, resolved by keeping the deletion", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		a.local.put("graph/nodes.jsonl", `${node("n1", "one")}\n${node("n2", "two")}\n`);
		for (let i = 0; i < 2; i++) { await cycle(a, folder); await cycle(b, folder); }
		a.local.put("graph/nodes.jsonl", `${node("n2", "two")}\n`); // laptop deletes n1
		b.local.put("graph/nodes.jsonl", `${node("n1", "one")}\n${node("n2", "two")}\n${node("n1", "one, edited")}\n`); // desktop adds to n1
		await cycle(a, folder); await cycle(b, folder); await cycle(a, folder);
		const conflict = a.conflicts.find(c => c.recordId === "n1");
		assert.ok(conflict, "the laptop is asked about n1");
		assert.equal(conflict.deletedOn, "local");
		await resolvePeerConflict(conflict, "local", { folder, local: a.local, cache: a.cache, state: a.state, deviceId: a.id });
		a.conflicts = a.conflicts.filter(c => c.id !== conflict.id);
		for (let i = 0; i < 3; i++) { await cycle(a, folder); await cycle(b, folder); }
		const desk = b.conflicts.find(c => c.recordId === "n1");
		if (desk) { await resolvePeerConflict(desk, "remote", { folder, local: b.local, cache: b.cache, state: b.state, deviceId: b.id }); b.conflicts = b.conflicts.filter(c => c.id !== desk.id); }
		for (let i = 0; i < 3; i++) { await cycle(a, folder); await cycle(b, folder); }
		for (const d of [a, b]) assert.ok(!d.local.text("graph/nodes.jsonl")!.includes('"n1"'), `${d.name}: n1 is gone`);
		assert.equal(a.local.text("graph/nodes.jsonl"), b.local.text("graph/nodes.jsonl"));
	});

	it("content removed by a cleanup elsewhere is uploaded again by the device that needs it", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop"), b = new Device("dev_desk001", "Desktop");
		a.local.put("chats/chat_x.json", chat("x", "kept"));
		await cycle(a, folder);
		const blob = folder.blobPath(hashBytes(Buffer.from(chat("x", "kept"))));
		store.files.delete(blob); // removed by another device's cleanup
		a.state.verifiedAt = "2000-01-01T00:00:00.000Z"; // the periodic check is due
		await cycle(a, folder);
		assert.ok(store.files.has(blob), "uploaded again");
		await cycle(b, folder);
		assert.equal(b.local.text("chats/chat_x.json"), chat("x", "kept"));
	});

	it("old content no snapshot uses is cleaned up after the grace period, never before", async () => {
		const store = new MemStore(), { id } = await newSync(store), folder = new PeerSyncFolder(store, id, null);
		const a = new Device("dev_laptop1", "Laptop");
		a.local.put("chats/chat_x.json", chat("x", "v1")); await cycle(a, folder);
		a.local.put("chats/chat_x.json", chat("x", "v2")); await cycle(a, folder);
		assert.equal((await folder.listBlobs()).length, 2);
		assert.equal(await collectPeerGarbage(folder), 0, "too recent");
		assert.equal(await collectPeerGarbage(folder, -1), 1, "the unused one goes");
		assert.equal((await folder.listBlobs()).length, 1);
	});
});

describe("password-protected syncs", () => {
	it("stores nothing readable; the right password opens it, a wrong one is refused", async () => {
		const store = new MemStore(), { id, keys } = await newSync(store, "correct horse");
		const folder = new PeerSyncFolder(store, id, keys);
		const a = new Device("dev_laptop1", "Laptop");
		a.local.put("chats/chat_secret.json", chat("secret", "my private notes about entropy"));
		a.local.put("graph/nodes.jsonl", `${node("n1", "Shannon entropy")}\n`);
		await cycle(a, folder);
		for (const [p, f] of store.files) {
			if (p.endsWith("/sync.json") || p.includes("/names/")) continue;
			const text = f.bytes.toString("latin1");
			assert.ok(!text.includes("entropy") && !text.includes("chat_secret") && !text.includes("Laptop"), `${p} is not readable`);
		}
		const meta = (await readPeerMeta(store, id))!;
		assert.ok(meta.crypto && !meta.info, "creator and dates are sealed");
		await assert.rejects(unlockSync("wrong password", id, meta.crypto), WrongSyncPasswordError);
		const opened = await unlockSync("correct horse", id, meta.crypto);
		assert.ok(keysFit(meta, opened));
		assert.ok(!keysFit(meta, await deriveSyncKeys("wrong password", meta.crypto)));
		const b = new Device("dev_desk001", "Desktop");
		await cycle(b, new PeerSyncFolder(store, id, opened));
		assert.equal(b.local.text("chats/chat_secret.json"), chat("secret", "my private notes about entropy"));
	});

	it("outsiders see the name and a lock only; members see the details", async () => {
		const store = new MemStore(), { id, keys } = await newSync(store, "correct horse");
		await cycle(new Device("dev_laptop1", "Laptop"), new PeerSyncFolder(store, id, keys));
		const [outside] = await listPeerSyncs(store);
		assert.deepEqual(outside, { id, name: "Studies", locked: true });
		const [inside] = await listPeerSyncs(store, () => keys);
		assert.equal(inside!.createdBy, "Laptop");
		assert.equal(inside!.devices![0]!.name, "Laptop");
	});
});

describe("version vectors", () => {
	it("tell behind, ahead and both-changed apart", () => {
		assert.equal(compareVv({ a: 1 }, { a: 2 }), "before");
		assert.equal(compareVv({ a: 2, b: 1 }, { a: 2 }), "after");
		assert.equal(compareVv({ a: 2, b: 1 }, { a: 3 }), "concurrent");
		assert.equal(compareVv({ a: 2 }, { a: 2 }), "equal");
	});
});
