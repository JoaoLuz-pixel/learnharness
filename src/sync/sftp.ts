/**
 * DEVICE SYNC — the SSH endpoint (owner design 2026-11-15). Devices log in
 * as the dedicated SFTP-only `learnharness` user, chrooted to its home; the
 * writable folder is /sync.
 *
 * SEVERAL SYNCS PER ENDPOINT (owner, 2026-11-20): each sync is one folder
 * with the layout below. The FIRST sync ("main") is the original /sync
 * itself, kept in place so devices on older versions keep syncing it; every
 * other sync lives in /sync/syncs/<id>/. Syncs are organisational, not
 * private: every device logs in as the same user (owner's choice).
 *
 *   <root>/meta.json            format stamp, name, who created it
 *   <root>/manifest.json        rel → {hash, device, at} (the truth list)
 *   <root>/data/<rel>           synced files
 *   <root>/devices/<id>.json    device registry (name, lastSeen)
 *   <root>/locks/<chatId>.json  "session active on <device>" while a turn runs
 *   <root>/.cycle-lock          one writer at a time per sync (exclusive create, TTL)
 *   /sync/tmp/                  write-then-rename staging (shared)
 *
 * Host keys are pinned (SHA256 fingerprint, OpenSSH format); a changed key
 * refuses the connection. Only the device's own private key authenticates.
 */
import { createHash, randomUUID } from "node:crypto";
import ssh2, { type Client as SshClient, type SFTPWrapper } from "ssh2";
// ssh2 is CommonJS: named ESM imports of its namespaces are not available.
const { Client, utils } = ssh2;
import { emptyManifest, type Manifest, type RemoteSide } from "./engine.ts";
import type { FolderStore } from "./peer.ts";

export const SYNC_ROOT = "/sync";
/** Password-protected syncs (owner, 2026-11-28) use the shared-folder
 *  layout here; app versions from before never look inside it. */
export const PEER_ROOT = `${SYNC_ROOT}/peer`;
export const SYNC_USER = "learnharness";
export const ENDPOINT_FORMAT = 1;
/** The original sync, in /sync itself. */
export const MAIN_SYNC_ID = "main";
/** Its name when it predates names (endpoints set up before 2026-11-20). */
export const MAIN_SYNC_DEFAULT_NAME = "Shared progress";
const SYNC_ID = /^s_[a-z0-9]{8,32}$/;

/** A sync id this app accepts: "main" or s_<8–32 lowercase alphanumerics>. */
export function isSyncId(id: unknown): id is string {
	return id === MAIN_SYNC_ID || (typeof id === "string" && SYNC_ID.test(id));
}
/** The folder a sync lives in on the endpoint. */
export function syncRoot(id: string): string {
	if (!isSyncId(id)) throw new Error(`Unknown sync ${String(id)}`);
	return id === MAIN_SYNC_ID ? SYNC_ROOT : `${SYNC_ROOT}/syncs/${id}`;
}
export function newSyncId(): string {
	return `s_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
/** Names are short plain text: trimmed, single-line, at most 60 characters. */
export function cleanSyncName(name: unknown): string {
	const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
	if (!clean) throw new Error("Give the sync a name");
	return clean;
}
const CYCLE_LOCK_TTL_MS = 60_000;

/** OpenSSH-style fingerprint: "SHA256:" + unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function generateDeviceKey(comment: string): { privateKey: string; publicKey: string } {
	const pair = utils.generateKeyPairSync("ed25519", { comment });
	return { privateKey: pair.private, publicKey: pair.public.trim() };
}

export class HostKeyMismatchError extends Error {
	constructor(readonly presented: string, readonly pinned: string) { super(`The endpoint's identity changed (expected ${pinned}, got ${presented}). Sync is blocked until you check it.`); }
}

export interface EndpointMeta { format: number; createdAt: string; createdBy: string; name?: string }
/** One sync as the chooser shows it. */
export interface SyncSummary { id: string; name: string; createdAt: string; createdBy: string; devices: DeviceRecord[] }
export interface DeviceRecord { id: string; name: string; lastSeen: string }
export interface SessionLock { chatId: string; deviceId: string; deviceName: string; expiresAt: string }

export interface ConnectOptions {
	host: string;
	port: number;
	privateKey: string;
	/** Pinned fingerprint; absent = first contact (the caller confirms it). */
	pinned?: string;
	timeoutMs?: number;
}

const p = <T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void) =>
	new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))));
const noSuchFile = (err: unknown) => (err as { code?: number }).code === 2;

export class SftpEndpoint implements RemoteSide {
	/** The selected sync's folder; every sync operation below works in it. */
	private root = SYNC_ROOT;
	private constructor(private client: SshClient, private sftp: SFTPWrapper, readonly fingerprint: string) {}

	static async connect(options: ConnectOptions): Promise<SftpEndpoint> {
		const client = new Client();
		let presented = "";
		const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
			client.once("error", reject);
			client.once("ready", () => client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper))));
			client.connect({
				host: options.host, port: options.port, username: SYNC_USER, privateKey: options.privateKey,
				readyTimeout: options.timeoutMs ?? 15_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
				// Key auth only: no passwords, no agent, no keyboard-interactive.
				tryKeyboard: false,
				hostVerifier: (key: Buffer) => {
					presented = hostKeyFingerprint(key);
					if (options.pinned && options.pinned !== presented) { reject(new HostKeyMismatchError(presented, options.pinned)); return false; }
					return true;
				},
			});
		}).catch((err) => { client.end(); throw err; });
		client.on("error", () => { /* surfaced by the next failing call */ });
		return new SftpEndpoint(client, sftp, presented);
	}

	/** Work in this sync from now on. */
	useSync(id: string): this { this.root = syncRoot(id); return this; }

	close(): void { this.client.end(); }
	onClose(listener: () => void): void { this.client.once("close", listener); }

	private dataPath(rel: string): string {
		if (rel.split("/").some(s => !s || s === "." || s === "..")) throw new Error(`Unsafe sync path ${rel}`);
		return `${this.root}/data/${rel}`;
	}
	private async readRaw(path: string): Promise<Buffer | null> {
		try { return await p<Buffer>(cb => this.sftp.readFile(path, cb)); }
		catch (err) { if (noSuchFile(err)) return null; throw err; }
	}
	private async mkdirp(dir: string): Promise<void> {
		let current = "";
		for (const part of dir.split("/").filter(Boolean)) {
			current += `/${part}`;
			try { await p(cb => this.sftp.mkdir(current, cb)); }
			catch { /* exists (or the next write reports the real error) */ }
		}
	}
	/** Write-then-rename: readers see old or new bytes, never a torn file. */
	private async writeRaw(path: string, bytes: Buffer): Promise<void> {
		await this.mkdirp(`${SYNC_ROOT}/tmp`);
		await this.mkdirp(path.slice(0, path.lastIndexOf("/")));
		const temp = `${SYNC_ROOT}/tmp/${randomUUID()}`;
		await p(cb => this.sftp.writeFile(temp, bytes, cb));
		try { await p(cb => this.sftp.ext_openssh_rename(temp, path, cb)); }
		catch {
			// Servers without posix-rename: replace explicitly.
			try { await p(cb => this.sftp.unlink(path, cb)); } catch { /* absent */ }
			await p(cb => this.sftp.rename(temp, path, cb));
		}
	}
	private async removeRaw(path: string): Promise<void> {
		try { await p(cb => this.sftp.unlink(path, cb)); } catch (err) { if (!noSuchFile(err)) throw err; }
	}
	private async listDir(dir: string): Promise<string[]> {
		try { return (await p<{ filename: string }[]>(cb => this.sftp.readdir(dir, cb))).map(e => e.filename); }
		catch (err) { if (noSuchFile(err)) return []; throw err; }
	}
	private async readJson<T>(path: string): Promise<T | null> {
		const raw = await this.readRaw(path);
		if (!raw) return null;
		try { return JSON.parse(raw.toString("utf8")) as T; } catch { return null; }
	}
	private writeJson(path: string, value: unknown) { return this.writeRaw(path, Buffer.from(JSON.stringify(value, null, "\t"))); }

	/** The shared-folder layout under /sync/peer (password-protected syncs). */
	folderStore(): FolderStore {
		const at = (rel: string) => {
			if (rel.split("/").some(s => !s || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s))) throw new Error(`Unsafe sync path ${rel}`);
			return `${PEER_ROOT}/${rel}`;
		};
		return {
			read: rel => this.readRaw(at(rel)),
			write: (rel, bytes) => this.writeRaw(at(rel), bytes),
			create: async (rel, bytes) => { if (!await this.statPath(at(rel))) await this.writeRaw(at(rel), bytes); },
			remove: rel => this.removeRaw(at(rel)),
			list: async dir => (await this.listDir(at(dir))).filter(name => !name.startsWith(".")),
			age: async rel => { const stat = await this.statPath(at(rel)); return stat ? Date.now() - stat.mtime * 1000 : null; },
		};
	}
	private async statPath(path: string): Promise<{ mtime: number } | null> {
		try { return await p<{ mtime: number }>(cb => this.sftp.stat(path, cb as never)); }
		catch (err) { if (noSuchFile(err)) return null; throw err; }
	}

	// RemoteSide
	read(rel: string) { return this.readRaw(this.dataPath(rel)); }
	write(rel: string, bytes: Buffer) { return this.writeRaw(this.dataPath(rel), bytes); }
	remove(rel: string) { return this.removeRaw(this.dataPath(rel)); }

	async readMeta(): Promise<EndpointMeta | null> { return this.readJson<EndpointMeta>(`${this.root}/meta.json`); }
	/** Create the selected sync (empty manifest). `name` is stored in meta. */
	async initialize(createdBy: string, name?: string): Promise<void> {
		await this.writeJson(`${this.root}/meta.json`, { format: ENDPOINT_FORMAT, createdAt: new Date().toISOString(), createdBy, ...(name ? { name: cleanSyncName(name) } : {}) } satisfies EndpointMeta);
		await this.writeJson(`${this.root}/manifest.json`, emptyManifest());
	}
	/** Make the selected sync's folder (before creating it: its cycle lock
	 *  lives there). Never called for an existing sync, so a removed one
	 *  is not brought back as an empty folder. */
	ensureSyncFolder() { return this.mkdirp(this.root); }
	/** Rename the selected sync (any device in it may). */
	async renameSync(name: string): Promise<void> {
		const meta = await this.readMeta();
		if (!meta) throw new Error("This sync no longer exists on the endpoint");
		await this.writeJson(`${this.root}/meta.json`, { ...meta, name: cleanSyncName(name) });
	}
	/** Every sync on the endpoint, with its paired devices. Read-only. */
	async listSyncs(): Promise<SyncSummary[]> {
		const ids = [MAIN_SYNC_ID, ...(await this.listDir(`${SYNC_ROOT}/syncs`)).filter(name => SYNC_ID.test(name)).sort()];
		const out: SyncSummary[] = [];
		const selected = this.root;
		try {
			for (const id of ids) {
				this.root = syncRoot(id);
				const meta = await this.readMeta();
				if (!meta) continue; // not a sync (main unused, or a half-created folder)
				out.push({ id, name: meta.name ?? (id === MAIN_SYNC_ID ? MAIN_SYNC_DEFAULT_NAME : id), createdAt: meta.createdAt, createdBy: meta.createdBy, devices: await this.listDevices() });
			}
		} finally { this.root = selected; }
		return out;
	}
	async readManifest(): Promise<Manifest> {
		const manifest = await this.readJson<Manifest>(`${this.root}/manifest.json`);
		return manifest && manifest.version === 1 && manifest.files && typeof manifest.files === "object" ? manifest : emptyManifest();
	}
	writeManifest(manifest: Manifest) { return this.writeJson(`${this.root}/manifest.json`, manifest); }

	async registerDevice(record: DeviceRecord): Promise<void> { await this.writeJson(`${this.root}/devices/${record.id}.json`, record); }
	/** Leave the selected sync's device list (Change sync). */
	unregisterDevice(deviceId: string) { return this.removeRaw(`${this.root}/devices/${deviceId}.json`); }
	async listDevices(): Promise<DeviceRecord[]> {
		const out: DeviceRecord[] = [];
		for (const name of await this.listDir(`${this.root}/devices`)) {
			if (!name.endsWith(".json")) continue;
			const record = await this.readJson<DeviceRecord>(`${this.root}/devices/${name}`);
			if (record && typeof record.id === "string" && typeof record.name === "string") out.push(record);
		}
		return out;
	}

	/** One writer at a time. Exclusive create; a lock older than its TTL is
	 *  a crashed device's and may be taken over. Returns false when busy. */
	async acquireCycleLock(deviceId: string): Promise<boolean> {
		const path = `${this.root}/.cycle-lock`;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await p<Buffer>(cb => this.sftp.open(path, "wx", cb));
				const body = Buffer.from(JSON.stringify({ deviceId, at: Date.now() }));
				await p(cb => this.sftp.write(handle, body, 0, body.length, 0, cb));
				await p(cb => this.sftp.close(handle, cb));
				return true;
			} catch {
				const held = await this.readJson<{ at?: number }>(path);
				if (held && typeof held.at === "number" && Date.now() - held.at < CYCLE_LOCK_TTL_MS) return false;
				await this.removeRaw(path); // stale: its owner died mid-cycle
			}
		}
		return false;
	}
	releaseCycleLock() { return this.removeRaw(`${this.root}/.cycle-lock`); }

	async writeSessionLock(lock: SessionLock): Promise<void> { await this.writeJson(`${this.root}/locks/${lock.chatId}.json`, lock); }
	removeSessionLock(chatId: string) { return this.removeRaw(`${this.root}/locks/${chatId}.json`); }
	async listSessionLocks(): Promise<SessionLock[]> {
		const out: SessionLock[] = [];
		for (const name of await this.listDir(`${this.root}/locks`)) {
			const lock = name.endsWith(".json") ? await this.readJson<SessionLock>(`${this.root}/locks/${name}`) : null;
			if (lock && typeof lock.chatId === "string" && typeof lock.expiresAt === "string") out.push(lock);
		}
		return out;
	}
}
