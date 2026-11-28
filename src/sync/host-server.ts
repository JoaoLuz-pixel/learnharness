/**
 * DEVICE SYNC — the built-in host (owner, 2026-11-28): "Host sync on this
 * device". The app runs its own SSH server; other devices reach it over the
 * local network or Tailscale (public internet addresses are refused).
 *
 * Access, all enforced here:
 *  - any device may connect with its own key and see the syncs' names;
 *  - to use a sync it must prove that sync's password once (the host keeps
 *    only a check value, never the password or the data key); the host then
 *    binds that device key to that sync;
 *  - a bound device reads its sync and writes only its own files there
 *    (host-protocol.ts); nobody but the host PC creates or removes a sync;
 *  - wrong passwords are rate limited per address.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import type { Connection, ServerChannel } from "ssh2";
import { authMatches } from "./crypto.ts";
import { LocalFolderStore } from "./folder-store.ts";
import { FrameReader, encodeFrame, hostAllows, HOST_PROTOCOL, HOST_SUBSYSTEM, isPrivateAddress, isTailscaleAddress, MAX_BLOB, MAX_JSON_FILE, type HostAccess } from "./host-protocol.ts";
import { collectPeerGarbage, createPeerSync, isDeviceId, isPeerSyncId, listPeerSyncs, newPeerSyncId, PeerSyncFolder, PEER_GC_INTERVAL_MS, readPeerMeta, type PeerSyncSummary } from "./peer.ts";
import { generateDeviceKey, hostKeyFingerprint, SYNC_USER } from "./sftp.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

const { Server, utils } = ssh2;

export const DEFAULT_HOST_PORT = 7419;
const JOIN_WINDOW_MS = 10 * 60 * 1000;
const JOIN_MAX_FAILURES = 5;

interface Membership { syncId: string; deviceId: string; joinedAt: string }
type Members = Record<string, Membership>;

export interface HostAddress { kind: "tailscale" | "lan"; address: string }

/** This computer's addresses other devices can use (Tailscale first). */
export function hostAddresses(interfaces = os.networkInterfaces()): HostAddress[] {
	const out: HostAddress[] = [];
	for (const list of Object.values(interfaces)) for (const entry of list ?? []) {
		if (entry.internal || !isPrivateAddress(entry.address)) continue;
		if (entry.family === "IPv6" && !isTailscaleAddress(entry.address)) continue; // LAN IPv6 link-local needs a zone: skip
		if (/^169\.254\./.test(entry.address)) continue;
		out.push({ kind: isTailscaleAddress(entry.address) ? "tailscale" : "lan", address: entry.address });
	}
	return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "tailscale" ? -1 : 1) || (a.address.includes(":") ? 1 : 0) - (b.address.includes(":") ? 1 : 0));
}

export class SyncHost {
	readonly store: LocalFolderStore;
	private server: InstanceType<typeof Server> | null = null;
	private clients = new Set<Connection>();
	private failures = new Map<string, number[]>();
	private gcTimer: ReturnType<typeof setInterval> | null = null;
	private hostKey: { privateKey: string; fingerprint: string };

	constructor(readonly dir: string, private onChange: () => void = () => {}) {
		this.store = new LocalFolderStore(path.join(dir, "store"));
		this.hostKey = this.loadHostKey();
	}

	get fingerprint(): string { return this.hostKey.fingerprint; }
	get running(): boolean { return !!this.server; }
	/** The port actually listened on (tests start on port 0). */
	get listeningPort(): number | null {
		const address = this.server?.address() as { port?: number } | string | null | undefined;
		return address && typeof address === "object" && typeof address.port === "number" ? address.port : null;
	}

	private loadHostKey(): { privateKey: string; fingerprint: string } {
		const file = path.join(this.dir, "host_ed25519");
		let privateKey: string;
		try { privateKey = fs.readFileSync(file, "utf8"); }
		catch {
			privateKey = generateDeviceKey("learnharness-host").privateKey;
			fs.mkdirSync(this.dir, { recursive: true });
			writeFileAtomicSync(file, privateKey, { mode: 0o600 });
		}
		const parsed = utils.parseKey(privateKey);
		if (parsed instanceof Error) throw parsed;
		const key = Array.isArray(parsed) ? parsed[0]! : parsed;
		return { privateKey, fingerprint: hostKeyFingerprint(key.getPublicSSH()) };
	}

	private membersFile() { return path.join(this.dir, "members.json"); }
	private members(): Members {
		try { const value = JSON.parse(fs.readFileSync(this.membersFile(), "utf8")) as Members; return value && typeof value === "object" ? value : {}; } catch { return {}; }
	}
	private saveMembers(members: Members) {
		fs.mkdirSync(this.dir, { recursive: true });
		writeFileAtomicSync(this.membersFile(), JSON.stringify(members, null, "\t"), { mode: 0o600 });
	}

	/* ── the host PC's own controls ── */
	async createSync(name: string, password: string, createdBy: string): Promise<string> {
		const id = newPeerSyncId();
		await createPeerSync(this.store, { id, name, createdBy, password });
		this.onChange();
		return id;
	}
	async listSyncs(): Promise<(PeerSyncSummary & { members: number })[]> {
		const members = Object.values(this.members());
		return (await listPeerSyncs(this.store)).map(s => ({ ...s, members: members.filter(m => m.syncId === s.id).length }));
	}

	async start(port: number): Promise<void> {
		if (this.server) return;
		const server = new Server({ hostKeys: [this.hostKey.privateKey], ident: "LearnHarness" }, (client, info) => this.accept(client, info.ip));
		server.on("error", () => { /* per-connection errors are handled on the client */ });
		await listen(server, port);
		this.server = server;
		this.gcTimer = setInterval(() => void this.collectGarbage(), PEER_GC_INTERVAL_MS);
		this.gcTimer.unref?.();
		void this.collectGarbage();
		this.onChange();
	}
	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (this.gcTimer) clearInterval(this.gcTimer);
		this.gcTimer = null;
		for (const client of this.clients) client.end();
		this.clients.clear();
		if (server) await new Promise<void>(resolve => server.close(() => resolve()));
		this.onChange();
	}
	async collectGarbage(): Promise<void> {
		for (const id of (await this.store.list("syncs")).filter(isPeerSyncId)) {
			try { await collectPeerGarbage(new PeerSyncFolder(this.store, id, null)); } catch { /* next round */ }
		}
	}

	/* ── one connection ── */
	private accept(client: Connection, ip: string): void {
		if (!isPrivateAddress(ip)) { client.end(); return; }
		this.clients.add(client);
		let keyId: string | null = null;
		client.on("authentication", ctx => {
			if (ctx.method !== "publickey" || ctx.username !== SYNC_USER) return ctx.reject(["publickey"]);
			const parsed = utils.parseKey(ctx.key.data);
			const key = parsed instanceof Error ? null : Array.isArray(parsed) ? parsed[0] : parsed;
			if (!key) return ctx.reject(["publickey"]);
			if (ctx.signature) {
				if (key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
				keyId = createHash("sha256").update(ctx.key.data).digest("base64");
			}
			ctx.accept();
		});
		client.on("ready", () => {
			client.on("session", acceptSession => {
				const session = acceptSession();
				session.on("subsystem", (acceptSub, reject, info) => {
					if (info.name !== HOST_SUBSYSTEM || !keyId) { reject(); return; }
					this.serve(acceptSub(), keyId, ip);
				});
			});
		});
		client.on("error", () => { /* the device reconnects */ });
		client.on("close", () => this.clients.delete(client));
	}

	private serve(channel: ServerChannel, keyId: string, ip: string): void {
		const reader = new FrameReader();
		let queue = Promise.resolve();
		channel.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try { frames = reader.push(chunk); } catch { channel.close(); return; }
			for (const frame of frames) {
				queue = queue.then(async () => {
					const request = frame as { id?: unknown; op?: unknown };
					const id = typeof request.id === "number" ? request.id : null;
					if (id === null) return;
					let reply: Record<string, unknown>;
					try { reply = { id, ok: true, ...(await this.handle(frame as Record<string, unknown>, keyId, ip)) }; }
					catch (err) { reply = { id, ok: false, error: err instanceof Error ? err.message : String(err) }; }
					channel.write(encodeFrame(reply));
				});
			}
		});
		channel.on("error", () => { /* closed under us */ });
	}

	private tooManyFailures(ip: string): boolean {
		const recent = (this.failures.get(ip) ?? []).filter(t => Date.now() - t < JOIN_WINDOW_MS);
		this.failures.set(ip, recent);
		return recent.length >= JOIN_MAX_FAILURES;
	}

	async handle(request: Record<string, unknown>, keyId: string, ip: string): Promise<Record<string, unknown>> {
		const op = request.op;
		if (op === "hello") return { protocol: HOST_PROTOCOL, name: os.hostname() };
		if (op === "list") {
			// Name and lock only, plus the key-derivation settings a device
			// needs to turn the typed password into its proof (never the check value).
			const syncs = [];
			for (const s of await listPeerSyncs(this.store)) {
				const c = (await readPeerMeta(this.store, s.id))?.crypto;
				syncs.push({ id: s.id, name: s.name, locked: s.locked, ...(c ? { crypto: { kdf: c.kdf, salt: c.salt, N: c.N, r: c.r, p: c.p } } : {}) });
			}
			return { syncs };
		}
		const members = this.members();
		if (op === "join") {
			const syncId = request.syncId, deviceId = request.deviceId, proof = request.proof;
			if (!isPeerSyncId(syncId) || !isDeviceId(deviceId) || typeof proof !== "string") throw new Error("Invalid request");
			if (this.tooManyFailures(ip)) throw new Error("Too many wrong passwords from this device. Wait 10 minutes and try again.");
			const meta = await readPeerMeta(this.store, syncId);
			if (!meta) throw new Error("That sync is no longer on this host.");
			if (!meta.crypto || !authMatches(Buffer.from(proof, "base64"), syncId, meta.crypto.check)) {
				this.failures.get(ip)!.push(Date.now());
				throw new Error("That password is not right for this sync.");
			}
			// Proving the password may take over a device id this host knew
			// under an older key (that device was forgotten and set up again).
			for (const [key, m] of Object.entries(members)) if (m.syncId === syncId && m.deviceId === deviceId && key !== keyId) delete members[key];
			members[keyId] = { syncId, deviceId, joinedAt: new Date().toISOString() };
			this.saveMembers(members); this.onChange();
			return {};
		}
		if (op === "leave") {
			if (members[keyId]) { delete members[keyId]; this.saveMembers(members); this.onChange(); }
			return {};
		}
		const member = members[keyId];
		if (!member) throw new Error("This device has not joined a sync on this host. Join it again with its password.");
		if (!await readPeerMeta(this.store, member.syncId)) throw new Error("That sync is no longer on this host.");
		const rel = typeof request.path === "string" ? request.path : "";
		const access = (op === "ls" ? "list" : op) as HostAccess;
		if (op === "list" || !["read", "list", "write", "create", "remove"].includes(access) || !hostAllows(access, rel, member.deviceId)) throw new Error("Not allowed");
		const full = `syncs/${member.syncId}/${rel}`;
		if (access === "read") { const bytes = await this.store.read(full); return { data: bytes ? bytes.toString("base64") : null }; }
		if (access === "list") return { names: await this.store.list(full) };
		if (access === "remove") { await this.store.remove(full); return {}; }
		if (typeof request.data !== "string") throw new Error("Invalid request");
		const bytes = Buffer.from(request.data, "base64");
		if (bytes.length > (access === "create" ? MAX_BLOB : MAX_JSON_FILE)) throw new Error("File too large for this host");
		if (access === "create") await this.store.create(full, bytes);
		else await this.store.write(full, bytes);
		return {};
	}
}

async function listen(server: InstanceType<typeof Server>, port: number): Promise<void> {
	const attempt = (host: string) => new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => { server.removeListener("listening", onListening); reject(err); };
		const onListening = () => { server.removeListener("error", onError); resolve(); };
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
	// Tests bind loopback only (no firewall prompt on the machine running them).
	const only = process.env.LH_SYNC_HOST_BIND;
	if (only) { await attempt(only); return; }
	try { await attempt("::"); }
	catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`Port ${port} is already in use on this computer. Choose another port.`);
		await attempt("0.0.0.0"); // no IPv6 on this computer
	}
}
