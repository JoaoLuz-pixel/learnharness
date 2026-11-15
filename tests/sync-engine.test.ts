/**
 * Device Sync cycles between two simulated devices and one in-memory
 * endpoint: seeding, joining, offline work, deletions, conflicts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyManifest, resolveConflict, runSyncCycle, type BaseSide, type LocalSide, type Manifest, type RemoteSide, type SyncConflict } from "../src/sync/engine.ts";
import { hashBytes } from "../src/sync/merge.ts";
import { DEFAULT_SYNC_TOGGLES } from "../src/sync/scope.ts";

class MemFiles {
	files = new Map<string, Buffer>();
	read = async (rel: string) => this.files.get(rel) ?? null;
	write = async (rel: string, bytes: Buffer) => { this.files.set(rel, Buffer.from(bytes)); };
	remove = async (rel: string) => { this.files.delete(rel); };
	text(rel: string) { return this.files.get(rel)?.toString("utf8"); }
	put(rel: string, text: string) { this.files.set(rel, Buffer.from(text)); }
}
class MemLocal extends MemFiles implements LocalSide {
	list = async () => new Map([...this.files].map(([rel, bytes]) => [rel, hashBytes(bytes)]));
}
class MemBase implements BaseSide {
	files = new Map<string, Buffer>();
	hash = (rel: string) => { const b = this.files.get(rel); return b ? hashBytes(b) : null; };
	read = (rel: string) => this.files.get(rel) ?? null;
	set = (rel: string, bytes: Buffer | null) => { if (bytes) this.files.set(rel, Buffer.from(bytes)); else this.files.delete(rel); };
	list = () => [...this.files.keys()];
}
class Device {
	local = new MemLocal();
	base = new MemBase();
	held: SyncConflict[] = [];
	constructor(public name: string) {}
}
class Endpoint { remote: RemoteSide & MemFiles = new MemFiles(); manifest: Manifest = emptyManifest(); }

async function sync(device: Device, endpoint: Endpoint) {
	const result = await runSyncCycle({ local: device.local, remote: endpoint.remote, base: device.base, manifest: endpoint.manifest, toggles: DEFAULT_SYNC_TOGGLES, deviceName: device.name, held: device.held, now: () => "2026-11-15T12:00:00Z" });
	device.held.push(...result.conflicts);
	return result;
}

const chat = (id: string, text: string) => JSON.stringify({ id, title: id, messages: [{ role: "user", content: text }] });
const node = (id: string, phrase: string) => JSON.stringify({ id, name: phrase, statement: phrase, aliases: [], createdAt: "t", provenance: [] });

describe("device sync cycles", () => {
	it("the first device seeds; a merging second device brings its own sessions; both converge", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("chats/chat_a.json", chat("a", "hello"));
		a.local.put("graph/nodes.jsonl", `${node("n1", "from laptop")}\n`);
		b.local.put("chats/chat_b.json", chat("b", "hi"));
		b.local.put("graph/nodes.jsonl", `${node("n2", "from desktop")}\n`);
		b.local.put("debug/trace.jsonl", "never synced");
		await sync(a, endpoint);
		assert.ok(endpoint.manifest.files["chats/chat_a.json"]);
		const joined = await sync(b, endpoint);
		assert.deepEqual(joined.conflicts, []);
		await sync(a, endpoint);
		for (const d of [a, b]) {
			assert.ok(d.local.text("chats/chat_a.json") && d.local.text("chats/chat_b.json"), `${d.name} has both sessions`);
			assert.match(d.local.text("graph/nodes.jsonl")!, /from laptop[\s\S]*from desktop|from desktop[\s\S]*from laptop/);
		}
		assert.equal(endpoint.remote.text("debug/trace.jsonl"), undefined, "out-of-scope files never leave the device");
	});

	it("offline work on one device is merged on reconnect, never overwritten", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("chats/chat_a.json", chat("a", "v1"));
		await sync(a, endpoint); await sync(b, endpoint);
		// B goes offline and keeps learning; A starts another session meanwhile.
		b.local.put("chats/chat_a.json", chat("a", "v2 written offline"));
		a.local.put("chats/chat_c.json", chat("c", "new on laptop"));
		await sync(a, endpoint);
		await sync(b, endpoint); // reconnect
		await sync(a, endpoint);
		assert.equal(a.local.text("chats/chat_a.json"), chat("a", "v2 written offline"));
		assert.equal(b.local.text("chats/chat_c.json"), chat("c", "new on laptop"));
	});

	it("deletions reach every device, even one that was away; deleted items never come back", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("chats/chat_a.json", chat("a", "x"));
		await sync(a, endpoint); await sync(b, endpoint);
		await a.local.remove("chats/chat_a.json");
		await sync(a, endpoint);
		assert.equal(endpoint.manifest.files["chats/chat_a.json"], undefined);
		await sync(b, endpoint); // months later
		assert.equal(b.local.text("chats/chat_a.json"), undefined, "deleted on the returning device");
		await sync(a, endpoint);
		assert.equal(a.local.text("chats/chat_a.json"), undefined, "not resurrected");
	});

	it("both devices edited one session → conflict; it stops syncing until resolved, others keep syncing", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("chats/chat_a.json", chat("a", "v1"));
		await sync(a, endpoint); await sync(b, endpoint);
		a.local.put("chats/chat_a.json", chat("a", "laptop edit"));
		b.local.put("chats/chat_a.json", chat("a", "desktop edit"));
		b.local.put("chats/chat_z.json", chat("z", "unrelated"));
		await sync(a, endpoint);
		const result = await sync(b, endpoint);
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0]!.remoteDevice, "Laptop");
		assert.ok(endpoint.manifest.files["chats/chat_z.json"], "the unrelated session still synced");
		assert.equal(b.local.text("chats/chat_a.json"), chat("a", "desktop edit"), "nothing overwritten while undecided");
		await sync(b, endpoint);
		assert.equal(b.held.length, 1, "no duplicate prompt on later cycles");

		// Keep both: the laptop's version becomes a separate session.
		await resolveConflict(b.held[0]!, "both", { local: b.local, remote: endpoint.remote, base: b.base, manifest: endpoint.manifest, deviceName: b.name,
			copyRel: (bytes) => ({ rel: "chats/chat_a_copy.json", bytes }) });
		b.held = [];
		await sync(b, endpoint); await sync(a, endpoint);
		assert.equal(a.local.text("chats/chat_a.json"), chat("a", "desktop edit"));
		assert.equal(a.local.text("chats/chat_a_copy.json"), chat("a", "laptop edit"));
	});

	it("deleted here but edited there → asked; choosing the edit restores it", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("chats/chat_a.json", chat("a", "v1"));
		await sync(a, endpoint); await sync(b, endpoint);
		await a.local.remove("chats/chat_a.json");
		b.local.put("chats/chat_a.json", chat("a", "kept learning"));
		await sync(b, endpoint);
		const result = await sync(a, endpoint);
		assert.equal(result.conflicts[0]!.deletedOn, "local");
		await resolveConflict(a.held[0]!, "remote", { local: a.local, remote: endpoint.remote, base: a.base, manifest: endpoint.manifest, deviceName: a.name });
		a.held = [];
		assert.equal(a.local.text("chats/chat_a.json"), chat("a", "kept learning"));
	});

	it("a node deleted on one device but extended on another is asked about, per node", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("graph/nodes.jsonl", `${node("n1", "keep")}\n${node("n2", "contested")}\n`);
		await sync(a, endpoint); await sync(b, endpoint);
		a.local.put("graph/nodes.jsonl", `${node("n1", "keep")}\n`);
		b.local.put("graph/nodes.jsonl", `${node("n1", "keep")}\n${node("n2", "contested")}\n${node("n2", "extended")}\n${node("n3", "new")}\n`);
		await sync(a, endpoint);
		const result = await sync(b, endpoint);
		assert.deepEqual(result.conflicts.map(c => [c.recordId, c.deletedOn]), [["n2", "remote"]]);
		assert.match(endpoint.remote.text("graph/nodes.jsonl")!, /"n3"/, "other nodes still synced");
		await resolveConflict(b.held[0]!, "remote", { local: b.local, remote: endpoint.remote, base: b.base, manifest: endpoint.manifest, deviceName: b.name });
		b.held = [];
		await sync(b, endpoint); await sync(a, endpoint);
		for (const d of [a, b]) assert.doesNotMatch(d.local.text("graph/nodes.jsonl")!, /"n2"/, `${d.name}: deletion chosen`);
	});

	it("refuses a remote file that does not match the manifest", async () => {
		const endpoint = new Endpoint(), a = new Device("Laptop"), b = new Device("Desktop");
		a.local.put("chats/chat_a.json", chat("a", "v1"));
		await sync(a, endpoint);
		endpoint.remote.put("chats/chat_a.json", "tampered");
		await assert.rejects(sync(b, endpoint), /does not match/);
		assert.equal(b.local.text("chats/chat_a.json"), undefined);
	});
});
