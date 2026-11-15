/**
 * DEVICE SYNC — the SSH endpoint (owner design 2026-11-15). Devices log in
 * as the dedicated SFTP-only `learnharness` user, chrooted to its home; the
 * writable folder is /sync. Layout:
 *
 *   /sync/meta.json            format stamp + who created it
 *   /sync/manifest.json        rel → {hash, device, at} (the truth list)
 *   /sync/data/<rel>           synced files
 *   /sync/devices/<id>.json    device registry (name, lastSeen)
 *   /sync/locks/<chatId>.json  "session active on <device>" while a turn runs
 *   /sync/.cycle-lock          one writer at a time (exclusive create, TTL)
 *   /sync/tmp/                 write-then-rename staging
 *
 * Host keys are pinned (SHA256 fingerprint, OpenSSH format); a changed key
 * refuses the connection. Only the device's own private key authenticates.
 */
import { createHash, randomUUID } from "node:crypto";
import ssh2, { type Client as SshClient, type SFTPWrapper } from "ssh2";
// ssh2 is CommonJS: named ESM imports of its namespaces are not available.
const { Client, utils } = ssh2;
import { emptyManifest, type Manifest, type RemoteSide } from "./engine.ts";

export const SYNC_ROOT = "/sync";
export const SYNC_USER = "learnharness";
export const ENDPOINT_FORMAT = 1;
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

export interface EndpointMeta { format: number; createdAt: string; createdBy: string }
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

	close(): void { this.client.end(); }
	onClose(listener: () => void): void { this.client.once("close", listener); }

	private dataPath(rel: string): string {
		if (rel.split("/").some(s => !s || s === "." || s === "..")) throw new Error(`Unsafe sync path ${rel}`);
		return `${SYNC_ROOT}/data/${rel}`;
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

	// RemoteSide
	read(rel: string) { return this.readRaw(this.dataPath(rel)); }
	write(rel: string, bytes: Buffer) { return this.writeRaw(this.dataPath(rel), bytes); }
	remove(rel: string) { return this.removeRaw(this.dataPath(rel)); }

	async readMeta(): Promise<EndpointMeta | null> { return this.readJson<EndpointMeta>(`${SYNC_ROOT}/meta.json`); }
	async initialize(createdBy: string): Promise<void> {
		await this.writeJson(`${SYNC_ROOT}/meta.json`, { format: ENDPOINT_FORMAT, createdAt: new Date().toISOString(), createdBy } satisfies EndpointMeta);
		await this.writeJson(`${SYNC_ROOT}/manifest.json`, emptyManifest());
	}
	async readManifest(): Promise<Manifest> {
		const manifest = await this.readJson<Manifest>(`${SYNC_ROOT}/manifest.json`);
		return manifest && manifest.version === 1 && manifest.files && typeof manifest.files === "object" ? manifest : emptyManifest();
	}
	writeManifest(manifest: Manifest) { return this.writeJson(`${SYNC_ROOT}/manifest.json`, manifest); }

	async registerDevice(record: DeviceRecord): Promise<void> { await this.writeJson(`${SYNC_ROOT}/devices/${record.id}.json`, record); }
	async listDevices(): Promise<DeviceRecord[]> {
		const out: DeviceRecord[] = [];
		for (const name of await this.listDir(`${SYNC_ROOT}/devices`)) {
			if (!name.endsWith(".json")) continue;
			const record = await this.readJson<DeviceRecord>(`${SYNC_ROOT}/devices/${name}`);
			if (record && typeof record.id === "string" && typeof record.name === "string") out.push(record);
		}
		return out;
	}

	/** One writer at a time. Exclusive create; a lock older than its TTL is
	 *  a crashed device's and may be taken over. Returns false when busy. */
	async acquireCycleLock(deviceId: string): Promise<boolean> {
		const path = `${SYNC_ROOT}/.cycle-lock`;
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
	releaseCycleLock() { return this.removeRaw(`${SYNC_ROOT}/.cycle-lock`); }

	async writeSessionLock(lock: SessionLock): Promise<void> { await this.writeJson(`${SYNC_ROOT}/locks/${lock.chatId}.json`, lock); }
	removeSessionLock(chatId: string) { return this.removeRaw(`${SYNC_ROOT}/locks/${chatId}.json`); }
	async listSessionLocks(): Promise<SessionLock[]> {
		const out: SessionLock[] = [];
		for (const name of await this.listDir(`${SYNC_ROOT}/locks`)) {
			const lock = name.endsWith(".json") ? await this.readJson<SessionLock>(`${SYNC_ROOT}/locks/${name}`) : null;
			if (lock && typeof lock.chatId === "string" && typeof lock.expiresAt === "string") out.push(lock);
		}
		return out;
	}
}
