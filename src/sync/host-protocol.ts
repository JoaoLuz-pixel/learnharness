/**
 * DEVICE SYNC — the built-in host's wire format (owner, 2026-11-28). Over an
 * SSH channel (subsystem "learnharness-sync"): 4-byte big-endian length,
 * then UTF-8 JSON. File bytes travel base64 in `data`.
 *
 * What a device may touch is decided HERE, on the host: a device can read
 * its own sync, write only its own files there, and add content blobs
 * (never replace one). No device can create, delete or overwrite a sync.
 */
import { isBlobName, isDeviceId } from "./peer.ts";

export const HOST_SUBSYSTEM = "learnharness-sync";
export const HOST_PROTOCOL = 1;
export const MAX_FRAME = 96 * 1024 * 1024;
export const MAX_JSON_FILE = 32 * 1024 * 1024;
export const MAX_BLOB = 64 * 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value));
	if (body.length > MAX_FRAME) throw new Error("Message too large");
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	return Buffer.concat([head, body]);
}

/** Incremental frame reader. Throws on an oversized frame (the caller closes). */
export class FrameReader {
	private chunks: Buffer[] = [];
	private size = 0;
	push(chunk: Buffer): unknown[] {
		this.chunks.push(chunk); this.size += chunk.length;
		const out: unknown[] = [];
		for (;;) {
			if (this.size < 4) break;
			const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
			this.chunks = [all];
			const length = all.readUInt32BE(0);
			if (length > MAX_FRAME) throw new Error("Message too large");
			if (all.length < 4 + length) break;
			out.push(JSON.parse(all.subarray(4, 4 + length).toString("utf8")));
			const rest = all.subarray(4 + length);
			this.chunks = rest.length ? [rest] : []; this.size = rest.length;
		}
		return out;
	}
}

export type HostAccess = "read" | "list" | "write" | "create" | "remove";
const OWN_FILES = new Set(["names", "snapshots", "devices", "locks"]);

/**
 * May the device `self` do `access` at `rel` (relative to its sync's root)?
 *  read:   sync.json, names/*, snapshots/*, devices/*, locks/*, blobs/*
 *  list:   names, snapshots, devices, locks, blobs
 *  write:  names|snapshots|devices|locks/<self>.json
 *  create: blobs/<64 hex>
 *  remove: snapshots|devices|locks/<self>.json
 */
export function hostAllows(access: HostAccess, rel: string, self: string): boolean {
	if (!isDeviceId(self) || typeof rel !== "string") return false;
	const parts = rel.split("/");
	if (access === "list") return parts.length === 1 && (OWN_FILES.has(parts[0]!) || parts[0] === "blobs");
	if (parts.length === 1) return access === "read" && parts[0] === "sync.json";
	if (parts.length !== 2) return false;
	const [dir, name] = parts as [string, string];
	if (dir === "blobs") return (access === "read" || access === "create") && isBlobName(name);
	if (!OWN_FILES.has(dir) || !name.endsWith(".json")) return false;
	const owner = name.slice(0, -5);
	if (!isDeviceId(owner)) return false;
	if (access === "read") return true;
	if (owner !== self) return false;
	if (access === "write") return true;
	return access === "remove" && dir !== "names";
}

/** Local-network and Tailscale addresses only (owner: never the public internet). */
export function isPrivateAddress(ip: string): boolean {
	let addr = ip.trim().toLowerCase();
	if (addr.startsWith("::ffff:")) addr = addr.slice(7);
	const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
			|| (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); // 100.64/10: Tailscale
	}
	if (addr === "::1") return true;
	// fc00::/7 (unique local, Tailscale's fd7a:115c:a1e0::/48 included), fe80::/10 link-local.
	return /^f[cd][0-9a-f]{2}:/.test(addr) || /^fe[89ab][0-9a-f]:/.test(addr);
}

/** Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(ip: string): boolean {
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
	return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
