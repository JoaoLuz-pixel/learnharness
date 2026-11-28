/**
 * Device Sync's built-in host over real SSH on localhost: who may do what,
 * passwords, and two devices syncing through it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { deriveSyncKeys, keysFromMaster } from "../src/sync/crypto.ts";
import { HostConnection, HostRefusedError, NotAHostError } from "../src/sync/host-client.ts";
import { hostAllows, isPrivateAddress, isTailscaleAddress } from "../src/sync/host-protocol.ts";
import { SyncHost } from "../src/sync/host-server.ts";
import { hashBytes } from "../src/sync/merge.ts";
import { createPeerSync, emptyPeerState, newPeerSyncId, PeerSyncFolder, readPeerMeta, runPeerCycle, type ContentCache } from "../src/sync/peer.ts";
import { generateDeviceKey, HostKeyMismatchError } from "../src/sync/sftp.ts";
import { DEFAULT_SYNC_TOGGLES } from "../src/sync/scope.ts";
import type { LocalSide } from "../src/sync/engine.ts";

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

describe("host access rules", () => {
	const me = "dev_laptop1", other = "dev_desk001";
	it("a device writes only its own files and adds blobs; never sync.json", () => {
		assert.ok(hostAllows("write", `snapshots/${me}.json`, me));
		assert.ok(!hostAllows("write", `snapshots/${other}.json`, me));
		assert.ok(!hostAllows("remove", `devices/${other}.json`, me));
		assert.ok(!hostAllows("write", "sync.json", me));
		assert.ok(hostAllows("read", "sync.json", me));
		assert.ok(hostAllows("create", `blobs/${"a".repeat(64)}`, me));
		assert.ok(!hostAllows("write", `blobs/${"a".repeat(64)}`, me), "a blob is never replaced");
		assert.ok(!hostAllows("remove", `blobs/${"a".repeat(64)}`, me));
		assert.ok(!hostAllows("read", "../other/sync.json", me));
		assert.ok(!hostAllows("read", "snapshots/../../x.json", me));
		assert.ok(!hostAllows("remove", `names/${me}.json`, me));
		assert.ok(hostAllows("list", "snapshots", me));
		assert.ok(!hostAllows("list", "", me));
	});
	it("only local-network and Tailscale addresses connect", () => {
		for (const ip of ["127.0.0.1", "192.168.1.20", "10.0.0.5", "172.20.1.1", "100.101.102.103", "::ffff:192.168.0.2", "fd7a:115c:a1e0::1", "::1"]) assert.ok(isPrivateAddress(ip), ip);
		for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860::8888", "::ffff:1.1.1.1"]) assert.ok(!isPrivateAddress(ip), ip);
		assert.ok(isTailscaleAddress("100.64.0.1")); assert.ok(!isTailscaleAddress("192.168.1.2"));
	});
});

class MemLocal implements LocalSide {
	files = new Map<string, Buffer>();
	list = async () => new Map([...this.files].map(([rel, bytes]) => [rel, hashBytes(bytes)]));
	read = async (rel: string) => this.files.get(rel) ?? null;
	write = async (rel: string, bytes: Buffer) => { this.files.set(rel, Buffer.from(bytes)); };
	remove = async (rel: string) => { this.files.delete(rel); };
}
const memCache = (): ContentCache => { const m = new Map<string, Buffer>(); return { get: h => m.get(h) ?? null, put: b => { m.set(hashBytes(b), b); } }; };

describe("the built-in host over SSH", () => {
	let dir: string, host: SyncHost, port: number, syncId: string;
	const laptopKey = generateDeviceKey("laptop").privateKey, deskKey = generateDeviceKey("desk").privateKey, strangerKey = generateDeviceKey("stranger").privateKey;
	before(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-host-"));
		host = new SyncHost(dir);
		await host.start(0);
		port = host.listeningPort!;
		syncId = newPeerSyncId();
		await createPeerSync(host.store, { id: syncId, name: "Studies", createdBy: "Host PC", password: "correct horse", kdf: FAST_KDF });
	});
	after(async () => { await host.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

	const connect = (privateKey: string, pinned?: string) => HostConnection.connect({ host: "127.0.0.1", port, privateKey, ...(pinned ? { pinned } : {}) });
	const keysFor = async (password: string) => {
		const listing = (await (await connect(laptopKey)).listSyncs()).find(s => s.id === syncId)!;
		return deriveSyncKeys(password, listing.crypto!);
	};

	it("lists names with a lock to anyone, and nothing else", async () => {
		const stranger = await connect(strangerKey);
		try {
			const [sync] = await stranger.listSyncs();
			assert.equal(sync!.name, "Studies"); assert.equal(sync!.locked, true);
			assert.ok(sync!.crypto && !("check" in sync!.crypto), "key settings but never the check value");
			await assert.rejects(stranger.store(syncId).read(`syncs/${syncId}/sync.json`), HostRefusedError, "a device that has not joined reads nothing");
			await assert.rejects(stranger.request("write", { path: "sync.json", data: "" }), HostRefusedError);
		} finally { stranger.close(); }
	});

	it("refuses a wrong password, accepts the right one, and pins its identity", async () => {
		const laptop = await connect(laptopKey);
		try {
			const wrong = await keysFor("not the password");
			await assert.rejects(laptop.join(syncId, "dev_laptop1", wrong.auth), /not right/);
			const right = await keysFor("correct horse");
			await laptop.join(syncId, "dev_laptop1", right.auth);
			assert.ok(await laptop.store(syncId).read(`syncs/${syncId}/sync.json`));
			await assert.rejects(laptop.store(syncId).write(`syncs/${syncId}/snapshots/dev_desk001.json`, Buffer.from("{}")), HostRefusedError, "not another device's file");
			await assert.rejects(laptop.store(syncId).write(`syncs/${syncId}/sync.json`, Buffer.from("{}")), /Not in this device's sync|Not allowed/);
			await assert.rejects(laptop.request("write", { path: "sync.json", data: "e30=" }), HostRefusedError, "never the sync itself");
			assert.equal(laptop.fingerprint, host.fingerprint);
		} finally { laptop.close(); }
		await assert.rejects(connect(laptopKey, "SHA256:somethingelse"), HostKeyMismatchError);
	});

	it("rate-limits wrong passwords from one address", async () => {
		const stranger = await connect(strangerKey);
		try {
			const wrong = await keysFor("guess");
			for (let i = 0; i < 5; i++) await assert.rejects(stranger.join(syncId, "dev_strange1", wrong.auth));
			const right = await keysFor("correct horse");
			await assert.rejects(stranger.join(syncId, "dev_strange1", right.auth), /Too many wrong passwords/);
		} finally { stranger.close(); }
		// (127.0.0.1 is now limited for 10 minutes: the next test joins from ::1.)
	});

	it("two devices sync through it; the host PC itself reads the same store", async () => {
		const right = keysFromMaster((await keysFor("correct horse")).master);
		const joinAt = async (key: string, deviceId: string) => {
			const c = await HostConnection.connect({ host: "::1", port, privateKey: key });
			await c.join(syncId, deviceId, right.auth);
			return c;
		};
		const laptop = await joinAt(laptopKey, "dev_laptop1"), desk = await joinAt(deskKey, "dev_desk001");
		try {
			const run = (c: HostConnection, id: string, local: MemLocal, state = emptyPeerState()) =>
				runPeerCycle({ folder: new PeerSyncFolder(c.store(syncId), syncId, right), local, cache: memCache(), state, deviceId: id, deviceName: id, toggles: DEFAULT_SYNC_TOGGLES, conflicts: [], paused: new Set() });
			const a = new MemLocal(), b = new MemLocal();
			a.files.set("chats/chat_a.json", Buffer.from('{"id":"a","title":"From laptop"}'));
			const sa = emptyPeerState(), sb = emptyPeerState();
			await run(laptop, "dev_laptop1", a, sa); await run(desk, "dev_desk001", b, sb);
			assert.equal(b.files.get("chats/chat_a.json")?.toString(), '{"id":"a","title":"From laptop"}');
			const meta = await readPeerMeta(host.store, syncId);
			const hostSide = new PeerSyncFolder(host.store, syncId, right);
			assert.ok(meta && (await hostSide.snapshotDevices()).includes("dev_desk001"), "the host PC sees both devices");
			assert.equal((await host.listSyncs())[0]!.members, 2);
		} finally { laptop.close(); desk.close(); }
	});

	it("an SSH server that is not a LearnHarness host is told apart", async () => {
		const { Server } = (await import("ssh2")).default;
		const plain = new Server({ hostKeys: [generateDeviceKey("plain").privateKey] }, client => {
			client.on("authentication", ctx => ctx.accept());
			client.on("ready", () => client.on("session", accept => { const s = accept(); s.on("subsystem", (_a, reject) => reject()); }));
		});
		await new Promise<void>(resolve => plain.listen(0, "127.0.0.1", () => resolve()));
		const plainPort = (plain.address() as { port: number }).port;
		try { await assert.rejects(HostConnection.connect({ host: "127.0.0.1", port: plainPort, privateKey: laptopKey }), NotAHostError); }
		finally { await new Promise<void>(resolve => plain.close(() => resolve())); }
	});
});
