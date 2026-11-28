/**
 * DEVICE SYNC — talking to another device's built-in host (owner,
 * 2026-11-28). Same SSH connection as an SSH endpoint (this device's own key,
 * the host's identity pinned on first contact), then the host's own channel
 * instead of SFTP.
 */
import ssh2, { type Client as SshClient, type ClientChannel } from "ssh2";
import { FrameReader, encodeFrame, HOST_SUBSYSTEM } from "./host-protocol.ts";
import { peerSyncRoot, type FolderStore } from "./peer.ts";
import { hostKeyFingerprint, HostKeyMismatchError, SYNC_USER, type ConnectOptions } from "./sftp.ts";

const { Client } = ssh2;
const REQUEST_TIMEOUT_MS = 120_000;

/** A sync as a host lists it: name and lock, and for a protected sync the
 *  settings that turn its password into a key (without the check value). */
export interface HostSyncListing { id: string; name: string; locked: boolean; crypto?: { kdf: "scrypt"; salt: string; N: number; r: number; p: number } }

/** The address answered, but it is not a LearnHarness host (an SSH endpoint). */
export class NotAHostError extends Error { constructor() { super("Not a LearnHarness host"); } }
/** A host refused a request (its own words). */
export class HostRefusedError extends Error {}

export class HostConnection {
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private closed = false;
	private constructor(private client: SshClient, private channel: ClientChannel, readonly fingerprint: string) {
		const reader = new FrameReader();
		channel.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try { frames = reader.push(chunk); } catch { this.close(); return; }
			for (const frame of frames) {
				const reply = frame as { id?: number; ok?: boolean; error?: string };
				const waiting = typeof reply.id === "number" ? this.pending.get(reply.id) : undefined;
				if (!waiting) continue;
				clearTimeout(waiting.timer); this.pending.delete(reply.id!);
				if (reply.ok) waiting.resolve(reply as Record<string, unknown>);
				else waiting.reject(new HostRefusedError(reply.error ?? "The host refused the request"));
			}
		});
		const fail = () => {
			this.closed = true;
			for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("The connection to the host closed.")); }
			this.pending.clear();
		};
		channel.on("close", fail);
		client.on("close", fail);
		client.on("error", () => { /* surfaced by the next failing request */ });
	}

	static async connect(options: ConnectOptions): Promise<HostConnection> {
		const client = new Client();
		let presented = "";
		await new Promise<void>((resolve, reject) => {
			client.once("error", reject);
			client.once("ready", () => resolve());
			client.connect({
				host: options.host, port: options.port, username: SYNC_USER, privateKey: options.privateKey,
				readyTimeout: options.timeoutMs ?? 15_000, keepaliveInterval: 10_000, keepaliveCountMax: 3, tryKeyboard: false,
				hostVerifier: (key: Buffer) => {
					presented = hostKeyFingerprint(key);
					if (options.pinned && options.pinned !== presented) { reject(new HostKeyMismatchError(presented, options.pinned)); return false; }
					return true;
				},
			});
		}).catch(err => { client.end(); throw err; });
		const channel = await new Promise<ClientChannel>((resolve, reject) => client.subsys(HOST_SUBSYSTEM, (err, stream) => (err ? reject(new NotAHostError()) : resolve(stream))))
			.catch(err => { client.end(); throw err; });
		const connection = new HostConnection(client, channel, presented);
		try { await connection.request("hello"); }
		catch (err) { connection.close(); throw err instanceof HostRefusedError ? err : new NotAHostError(); }
		return connection;
	}

	request(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		if (this.closed) return Promise.reject(new Error("The connection to the host closed."));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("The host did not answer in time.")); }, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.channel.write(encodeFrame({ ...fields, id, op }));
		});
	}

	async listSyncs(): Promise<HostSyncListing[]> {
		const reply = await this.request("list");
		return Array.isArray(reply.syncs) ? (reply.syncs as HostSyncListing[]).filter(s => typeof s?.id === "string" && typeof s.name === "string") : [];
	}
	async join(syncId: string, deviceId: string, auth: Buffer): Promise<void> { await this.request("join", { syncId, deviceId, proof: auth.toString("base64") }); }
	async leave(): Promise<void> { await this.request("leave"); }

	/** The joined sync, as a FolderStore (paths "syncs/<id>/…"). */
	store(syncId: string): FolderStore {
		const prefix = `${peerSyncRoot(syncId)}/`;
		const strip = (path: string) => {
			if (!path.startsWith(prefix)) throw new Error("Not in this device's sync");
			return path.slice(prefix.length);
		};
		return {
			read: async path => {
				const reply = await this.request("read", { path: strip(path) });
				return typeof reply.data === "string" ? Buffer.from(reply.data, "base64") : null;
			},
			write: async (path, bytes) => { await this.request("write", { path: strip(path), data: bytes.toString("base64") }); },
			create: async (path, bytes) => { await this.request("create", { path: strip(path), data: bytes.toString("base64") }); },
			remove: async path => { await this.request("remove", { path: strip(path) }); },
			list: async dir => {
				const reply = await this.request("ls", { path: strip(`${dir}/`).replace(/\/$/, "") || "" });
				return Array.isArray(reply.names) ? reply.names.filter((n): n is string => typeof n === "string") : [];
			},
		};
	}

	close(): void { this.closed = true; this.client.end(); }
	onClose(listener: () => void): void { this.client.once("close", listener); }
}
