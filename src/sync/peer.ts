/**
 * DEVICE SYNC — the shared-folder layout (owner, 2026-11-28), used by cloud
 * folders (OneDrive, iCloud Drive, any synced folder), the built-in host and
 * password-protected syncs on SSH endpoints.
 *
 * A cloud folder copies files with delays, in any order, and has no locks.
 * So in this layout NO TWO DEVICES EVER WRITE THE SAME FILE:
 *
 *   syncs/<id>/sync.json            created once: name, crypto params
 *   syncs/<id>/names/<device>.json  renames (newest wins)
 *   syncs/<id>/snapshots/<device>.json  that device's view: rel → {hash, version}
 *   syncs/<id>/blobs/<name>         file contents, named by their hash (never rewritten)
 *   syncs/<id>/devices/<device>.json    name, last seen
 *   syncs/<id>/locks/<device>.json      sessions running a turn there
 *
 * Every entry carries a version vector (device → change count). Comparing two
 * vectors tells "they are behind", "I am behind" or "both changed" exactly,
 * however long a device was offline, so a pull never overwrites an edit it
 * has not seen. Both changed: sessions and other whole files become a
 * conflict the learner resolves (as with SSH endpoints); graph ledgers and
 * positions merge with the same rules as before, against the last content
 * this device agreed on with that peer. A missing snapshot means "no news",
 * never "deleted": only an explicit deletion entry deletes.
 */
import { randomUUID } from "node:crypto";
import { authMatches, blobName, createSyncCrypto, open, seal, type SyncCryptoParams, type SyncKeys } from "./crypto.ts";
import { conflictId, type LocalSide, type SyncConflict } from "./engine.ts";
import { hashBytes, ledgerLineId, mergeLedger, mergePositions } from "./merge.ts";
import { classifySyncPath, inSyncScope, type SyncToggles } from "./scope.ts";

/** One stored location (cloud folder, host, SFTP), "/"-separated paths. */
export interface FolderStore {
	read(path: string): Promise<Buffer | null>;
	/** Replace the whole file (readers see old or new bytes). */
	write(path: string, bytes: Buffer): Promise<void>;
	/** Write only if absent (blobs: same name = same content). */
	create(path: string, bytes: Buffer): Promise<void>;
	remove(path: string): Promise<void>;
	/** File and folder names in `dir`; [] when it does not exist. */
	list(dir: string): Promise<string[]>;
	/** Milliseconds since `path` last changed (cleanup only); null = unknown. */
	age?(path: string): Promise<number | null>;
}

export const PEER_FORMAT = 2;
const PEER_SYNC_ID = /^p_[a-z0-9]{16}$/;
const DEVICE_ID = /^dev_[A-Za-z0-9-]{4,40}$/;
const BLOB_NAME = /^[0-9a-f]{64}$/;
export const BLOB_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const PEER_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const isPeerSyncId = (id: unknown): id is string => typeof id === "string" && PEER_SYNC_ID.test(id);
export const isDeviceId = (id: unknown): id is string => typeof id === "string" && DEVICE_ID.test(id);
export const isBlobName = (name: unknown): name is string => typeof name === "string" && BLOB_NAME.test(name);
export const newPeerSyncId = (): string => `p_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const peerSyncRoot = (id: string): string => {
	if (!isPeerSyncId(id)) throw new Error(`Unknown sync ${String(id)}`);
	return `syncs/${id}`;
};

/* ── version vectors ── */
export type VersionVector = Record<string, number>;
export interface PeerEntry { h: string | null; vv: VersionVector }
export type VvOrder = "equal" | "before" | "after" | "concurrent";

export function compareVv(a: VersionVector, b: VersionVector): VvOrder {
	let less = false, more = false;
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const x = a[key] ?? 0, y = b[key] ?? 0;
		if (x < y) less = true;
		if (x > y) more = true;
	}
	return less && more ? "concurrent" : less ? "before" : more ? "after" : "equal";
}
export function maxVv(a: VersionVector, b: VersionVector): VersionVector {
	const out: VersionVector = { ...a };
	for (const [key, n] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, n);
	return out;
}
export const bumpVv = (vv: VersionVector, device: string): VersionVector => ({ ...vv, [device]: (vv[device] ?? 0) + 1 });
const copyEntry = (e: PeerEntry): PeerEntry => ({ h: e.h, vv: { ...e.vv } });

function validEntry(value: unknown): value is PeerEntry {
	const e = value as PeerEntry | null;
	if (!e || typeof e !== "object" || !(e.h === null || (typeof e.h === "string" && /^[0-9a-f]{64}$/.test(e.h)))) return false;
	if (!e.vv || typeof e.vv !== "object") return false;
	return Object.entries(e.vv).every(([k, n]) => isDeviceId(k) && Number.isSafeInteger(n) && n > 0);
}

/* ── the sync folder ── */
export interface PeerSyncMeta {
	format: number;
	id: string;
	/** The name at creation (renames live in names/). Always plain: a
	 *  protected sync shows its name and a lock to outsiders (owner). */
	name: string;
	/** Present = password-protected. */
	crypto?: SyncCryptoParams;
	/** Plain for open syncs; sealed (base64) for protected ones. */
	info?: { createdAt: string; createdBy: string };
	sealedInfo?: string;
}

export interface PeerDeviceRecord { id: string; name: string; lastSeen: string }
export interface PeerLockFile { deviceId: string; deviceName: string; chats: { chatId: string; expiresAt: string }[] }
export interface PeerSnapshot { format: number; device: string; at: string; files: Record<string, PeerEntry> }
/** The stored wrapper: blob refs stay readable so a host can clean up
 *  without any key; the body is sealed for protected syncs. */
interface SnapshotFile { format: number; refs: string[]; plain?: PeerSnapshot; sealed?: string }

/** One sync inside a FolderStore, with its keys when it is protected. */
export class PeerSyncFolder {
	readonly root: string;
	constructor(readonly store: FolderStore, readonly id: string, readonly keys: SyncKeys | null) { this.root = peerSyncRoot(id); }

	private place(rel: string) { return `${this.root}/${rel}`; }
	private async readSecret(rel: string): Promise<Buffer | null> {
		const raw = await this.store.read(this.place(rel));
		if (!raw) return null;
		return this.keys ? open(this.keys, raw, rel) : raw;
	}
	private writeSecret(rel: string, bytes: Buffer) { return this.store.write(this.place(rel), this.keys ? seal(this.keys, bytes, rel) : bytes); }
	private async readJsonSecret<T>(rel: string): Promise<T | null> {
		try { const raw = await this.readSecret(rel); return raw ? JSON.parse(raw.toString("utf8")) as T : null; }
		catch { return null; } // half-copied (cloud) or damaged: "no news" this cycle
	}

	async readMeta(): Promise<PeerSyncMeta | null> { return readPeerMeta(this.store, this.id); }
	/** The name devices see: the newest rename, else the creation name. */
	async currentName(meta?: PeerSyncMeta | null): Promise<string> { return currentPeerName(this.store, this.id, meta ?? await this.readMeta()); }
	async rename(deviceId: string, name: string): Promise<void> {
		await this.store.write(this.place(`names/${deviceId}.json`), Buffer.from(JSON.stringify({ name, at: new Date().toISOString() })));
	}
	async info(meta: PeerSyncMeta): Promise<{ createdAt: string; createdBy: string } | null> {
		if (meta.info) return meta.info;
		if (!meta.sealedInfo || !this.keys) return null;
		try { return JSON.parse(open(this.keys, Buffer.from(meta.sealedInfo, "base64"), "sync.json#info").toString("utf8")) as { createdAt: string; createdBy: string }; } catch { return null; }
	}

	/* blobs */
	blobPath(hash: string) { return this.place(`blobs/${blobName(this.keys, hash)}`); }
	async writeBlob(hash: string, bytes: Buffer): Promise<void> {
		const name = blobName(this.keys, hash);
		await this.store.create(this.place(`blobs/${name}`), this.keys ? seal(this.keys, bytes, `blobs/${name}`) : bytes);
	}
	/** The blob for `hash`, verified; null while it has not arrived yet. */
	async readBlob(hash: string): Promise<Buffer | null> {
		const name = blobName(this.keys, hash);
		const raw = await this.store.read(this.place(`blobs/${name}`));
		if (!raw) return null;
		let bytes: Buffer;
		try { bytes = this.keys ? open(this.keys, raw, `blobs/${name}`) : raw; } catch { return null; }
		return hashBytes(bytes) === hash ? bytes : null; // a half-copied file: try again next cycle
	}
	async listBlobs(): Promise<string[]> { return (await this.store.list(this.place("blobs"))).filter(isBlobName); }
	removeBlob(name: string) { return this.store.remove(this.place(`blobs/${name}`)); }

	/* snapshots */
	async snapshotDevices(): Promise<string[]> {
		return (await this.store.list(this.place("snapshots"))).filter(n => n.endsWith(".json")).map(n => n.slice(0, -5)).filter(isDeviceId);
	}
	async readSnapshotFile(device: string): Promise<SnapshotFile | null> {
		const raw = await this.store.read(this.place(`snapshots/${device}.json`));
		if (!raw) return null;
		try { return JSON.parse(raw.toString("utf8")) as SnapshotFile; } catch { return null; }
	}
	async readSnapshot(device: string): Promise<PeerSnapshot | null> {
		const file = await this.readSnapshotFile(device);
		if (!file || file.format !== PEER_FORMAT) return null;
		let snap: PeerSnapshot | null = null;
		try {
			if (this.keys) { if (!file.sealed) return null; snap = JSON.parse(open(this.keys, Buffer.from(file.sealed, "base64"), `snapshots/${device}.json`).toString("utf8")) as PeerSnapshot; }
			else snap = file.plain ?? null;
		} catch { return null; }
		if (!snap || snap.device !== device || !snap.files || typeof snap.files !== "object") return null;
		const files: Record<string, PeerEntry> = {};
		for (const [rel, entry] of Object.entries(snap.files)) if (classifySyncPath(rel) && validEntry(entry)) files[rel] = entry;
		return { ...snap, files };
	}
	async writeSnapshot(snap: PeerSnapshot): Promise<void> {
		const refs = [...new Set(Object.values(snap.files).flatMap(e => e.h ? [blobName(this.keys, e.h)] : []))].sort();
		const file: SnapshotFile = this.keys
			? { format: PEER_FORMAT, refs, sealed: seal(this.keys, Buffer.from(JSON.stringify(snap)), `snapshots/${snap.device}.json`).toString("base64") }
			: { format: PEER_FORMAT, refs, plain: snap };
		await this.store.write(this.place(`snapshots/${snap.device}.json`), Buffer.from(JSON.stringify(file)));
	}
	removeSnapshot(device: string) { return this.store.remove(this.place(`snapshots/${device}.json`)); }

	/* devices and session locks */
	writeDevice(record: PeerDeviceRecord) { return this.writeSecret(`devices/${record.id}.json`, Buffer.from(JSON.stringify(record))); }
	removeDevice(id: string) { return this.store.remove(this.place(`devices/${id}.json`)); }
	async listDevices(): Promise<PeerDeviceRecord[]> {
		const out: PeerDeviceRecord[] = [];
		for (const name of await this.store.list(this.place("devices"))) {
			const id = name.endsWith(".json") ? name.slice(0, -5) : "";
			if (!isDeviceId(id)) continue;
			const record = await this.readJsonSecret<PeerDeviceRecord>(`devices/${name}`);
			if (record && record.id === id && typeof record.name === "string" && typeof record.lastSeen === "string") out.push(record);
		}
		return out;
	}
	writeLocks(file: PeerLockFile) { return this.writeSecret(`locks/${file.deviceId}.json`, Buffer.from(JSON.stringify(file))); }
	removeLocks(id: string) { return this.store.remove(this.place(`locks/${id}.json`)); }
	async listLocks(): Promise<{ chatId: string; deviceId: string; deviceName: string; expiresAt: string }[]> {
		const out: { chatId: string; deviceId: string; deviceName: string; expiresAt: string }[] = [];
		for (const name of await this.store.list(this.place("locks"))) {
			const id = name.endsWith(".json") ? name.slice(0, -5) : "";
			if (!isDeviceId(id)) continue;
			const file = await this.readJsonSecret<PeerLockFile>(`locks/${name}`);
			if (!file || file.deviceId !== id || !Array.isArray(file.chats)) continue;
			for (const chat of file.chats) if (typeof chat?.chatId === "string" && typeof chat.expiresAt === "string") out.push({ chatId: chat.chatId, deviceId: id, deviceName: String(file.deviceName ?? id), expiresAt: chat.expiresAt });
		}
		return out;
	}
}

export async function readPeerMeta(store: FolderStore, id: string): Promise<PeerSyncMeta | null> {
	const raw = await store.read(`${peerSyncRoot(id)}/sync.json`);
	if (!raw) return null;
	try {
		const meta = JSON.parse(raw.toString("utf8")) as PeerSyncMeta;
		return meta && meta.format === PEER_FORMAT && meta.id === id && typeof meta.name === "string" ? meta : null;
	} catch { return null; }
}
async function currentPeerName(store: FolderStore, id: string, meta: PeerSyncMeta | null): Promise<string> {
	let best: { name: string; at: string } | null = null;
	for (const file of await store.list(`${peerSyncRoot(id)}/names`)) {
		if (!file.endsWith(".json") || !isDeviceId(file.slice(0, -5))) continue;
		try {
			const value = JSON.parse((await store.read(`${peerSyncRoot(id)}/names/${file}`))?.toString("utf8") ?? "") as { name?: unknown; at?: unknown };
			if (typeof value.name === "string" && typeof value.at === "string" && (!best || value.at > best.at)) best = { name: value.name.slice(0, 60), at: value.at };
		} catch { /* half-copied */ }
	}
	return best?.name ?? meta?.name ?? id;
}

/** A sync as the chooser lists it. Protected: name and lock only, unless
 *  `keys` for it are given (this device is in it). */
export interface PeerSyncSummary { id: string; name: string; locked: boolean; createdAt?: string; createdBy?: string; devices?: PeerDeviceRecord[] }

export async function listPeerSyncs(store: FolderStore, keysFor: (id: string) => SyncKeys | null = () => null): Promise<PeerSyncSummary[]> {
	const out: PeerSyncSummary[] = [];
	for (const id of (await store.list("syncs")).filter(isPeerSyncId).sort()) {
		const meta = await readPeerMeta(store, id);
		if (!meta) continue;
		const keys = meta.crypto ? keysFor(id) : null;
		const name = await currentPeerName(store, id, meta);
		if (meta.crypto && !keys) { out.push({ id, name, locked: true }); continue; }
		const folder = new PeerSyncFolder(store, id, keys);
		const info = await folder.info(meta);
		out.push({ id, name, locked: !!meta.crypto, ...(info ? { createdAt: info.createdAt, createdBy: info.createdBy } : {}), devices: await folder.listDevices() });
	}
	return out;
}

/** Create a sync (sync.json written once). Returns its keys when protected. */
export async function createPeerSync(store: FolderStore, options: { id: string; name: string; createdBy: string; password?: string; kdf?: { N: number; r: number; p: number } }): Promise<SyncKeys | null> {
	if (await readPeerMeta(store, options.id)) throw new Error("A sync with this id already exists");
	const info = { createdAt: new Date().toISOString(), createdBy: options.createdBy };
	let meta: PeerSyncMeta = { format: PEER_FORMAT, id: options.id, name: options.name, info };
	let keys: SyncKeys | null = null;
	if (options.password !== undefined) {
		const made = await createSyncCrypto(options.password, options.id, options.kdf);
		keys = made.keys;
		meta = { format: PEER_FORMAT, id: options.id, name: options.name, crypto: made.params, sealedInfo: seal(keys, Buffer.from(JSON.stringify(info)), "sync.json#info").toString("base64") };
	}
	await store.write(`${peerSyncRoot(options.id)}/sync.json`, Buffer.from(JSON.stringify(meta, null, "\t")));
	return keys;
}

/** Can these keys open this sync? (A remembered key from another sync,
 *  or a sync re-created under the same id, must not be used.) */
export function keysFit(meta: PeerSyncMeta, keys: SyncKeys | null): boolean {
	if (!meta.crypto) return keys === null;
	return !!keys && authMatches(keys.auth, meta.id, meta.crypto.check);
}

/* ── local state for one sync ── */
export interface PeerState {
	version: 1;
	/** This device's view of every synced file. */
	entries: Record<string, PeerEntry>;
	/** Content hashes already stored as blobs (skip re-uploads). */
	uploaded: Record<string, true>;
	/** Ledgers/positions: the content last agreed with each peer (merge base). */
	agreed: Record<string, Record<string, string>>;
	/** The last snapshot written (without its time), to skip unchanged writes. */
	published: string | null;
	deviceWrittenAt: string | null;
	gcAt: string | null;
	/** Highest change count the sync knew for this device when it joined. */
	floor?: number;
	/** When this device last checked its contents are still stored. */
	verifiedAt?: string;
}
export const emptyPeerState = (): PeerState => ({ version: 1, entries: {}, uploaded: {}, agreed: {}, published: null, deviceWrittenAt: null, gcAt: null });

/** Ledger/positions contents this device keeps locally (merge bases). */
export interface ContentCache { get(hash: string): Buffer | null; put(bytes: Buffer): void }

/** A conflict from a peer: which device's version it is against. */
export interface PeerConflict extends SyncConflict { peer: string }

export interface PeerCycleInput {
	folder: PeerSyncFolder;
	local: LocalSide;
	cache: ContentCache;
	state: PeerState;
	deviceId: string;
	deviceName: string;
	toggles: SyncToggles;
	/** Conflicts still waiting for the learner. */
	conflicts: readonly PeerConflict[];
	/** Files that must not change right now (a turn is running here). */
	paused: ReadonlySet<string>;
	now?: () => string;
}
export interface PeerCycleResult {
	pulled: string[];
	deletedLocal: string[];
	conflicts: PeerConflict[];
	/** Waiting conflicts another device has resolved meanwhile. */
	cleared: string[];
	/** Files whose content has not arrived yet (cloud delay): retried. */
	waiting: string[];
	devices: PeerDeviceRecord[];
}

const DEVICE_REFRESH_MS = 5 * 60 * 1000;
const VERIFY_INTERVAL_MS = 10 * 60 * 1000;

export async function runPeerCycle(input: PeerCycleInput): Promise<PeerCycleResult> {
	const { folder, local, cache, state, deviceId: me, toggles } = input;
	const now = input.now ?? (() => new Date().toISOString());
	const result: PeerCycleResult = { pulled: [], deletedLocal: [], conflicts: [], cleared: [], waiting: [], devices: [] };
	const open = new Map(input.conflicts.map(c => [c.id, c]));
	const fileConflict = (rel: string) => open.has(conflictId(rel));
	const heldIds = (rel: string) => new Set([...open.values()].filter(c => c.rel === rel && c.recordId).map(c => c.recordId!));
	const clearFor = (rel: string) => { for (const [id, c] of open) if (c.rel === rel) { open.delete(id); result.cleared.push(id); } };
	const scope = (rel: string) => inSyncScope(rel, toggles);

	// Every other device's view, read once.
	const snapshots: PeerSnapshot[] = [];
	for (const peer of (await folder.snapshotDevices()).filter(d => d !== me).sort()) {
		const snap = await folder.readSnapshot(peer);
		if (snap) snapshots.push(snap);
	}
	// A device joining (or re-joining after Forget) starts its counters above
	// anything the sync remembers from it: its files then read as "changed
	// here too", never as older versions to be replaced.
	if (state.published === null && !Object.keys(state.entries).length) {
		for (const snap of snapshots) for (const entry of Object.values(snap.files)) state.floor = Math.max(state.floor ?? 0, entry.vv[me] ?? 0);
		const own = await folder.readSnapshot(me);
		for (const entry of Object.values(own?.files ?? {})) state.floor = Math.max(state.floor ?? 0, entry.vv[me] ?? 0);
	}

	// 1. This device's own changes become new versions.
	const localMap = await local.list();
	for (const rel of new Set([...localMap.keys(), ...Object.keys(state.entries)])) {
		if (!scope(rel) || input.paused.has(rel)) continue;
		const entry = state.entries[rel], l = localMap.get(rel) ?? null;
		if (!entry) { if (l !== null) state.entries[rel] = { h: l, vv: { [me]: (state.floor ?? 0) + 1 } }; }
		else if (entry.h !== l) state.entries[rel] = { h: l, vv: bumpVv(entry.vv, me) };
	}
	const upload = async (rel: string, entry: PeerEntry, known?: Buffer) => {
		if (!entry.h || state.uploaded[entry.h]) return;
		const bytes = known ?? await local.read(rel);
		if (!bytes || hashBytes(bytes) !== entry.h) return; // changed mid-cycle: the next cycle uploads
		await folder.writeBlob(entry.h, bytes);
		state.uploaded[entry.h] = true;
	};
	// Every few minutes, check that this device's own contents are still
	// stored (a cleanup elsewhere may have removed one that arrived late
	// through the cloud): anything missing is uploaded again.
	if (!state.verifiedAt || Date.now() - Date.parse(state.verifiedAt) > VERIFY_INTERVAL_MS) {
		const stored = new Set(await folder.listBlobs());
		for (const hash of Object.keys(state.uploaded)) if (!stored.has(blobName(folder.keys, hash))) delete state.uploaded[hash];
		state.verifiedAt = now();
	}
	for (const [rel, entry] of Object.entries(state.entries)) if (scope(rel) && !input.paused.has(rel)) await upload(rel, entry);

	// 2. Every other device's view, one at a time.
	const agree = (peer: string, rel: string, hash: string | null) => {
		if (!hash || scope(rel)?.kind === "file") return;
		(state.agreed[peer] ??= {})[rel] = hash;
	};
	const contentOf = async (hash: string | null): Promise<Buffer | null | undefined> => {
		if (!hash) return null;
		const bytes = cache.get(hash) ?? await folder.readBlob(hash);
		if (bytes) cache.put(bytes);
		return bytes ?? undefined; // undefined = not arrived yet
	};
	const apply = async (rel: string, theirs: PeerEntry): Promise<boolean> => {
		if (theirs.h === null) {
			if ((localMap.get(rel) ?? null) !== null) { await local.remove(rel); result.deletedLocal.push(rel); }
		} else {
			const bytes = await folder.readBlob(theirs.h);
			if (!bytes) { result.waiting.push(rel); return false; }
			if (scope(rel)?.kind !== "file") cache.put(bytes);
			await local.write(rel, bytes); result.pulled.push(rel);
			state.uploaded[theirs.h] = true;
		}
		if (theirs.h === null) localMap.delete(rel);
		else localMap.set(rel, theirs.h);
		return true;
	};

	for (const snap of snapshots) {
		const peer = snap.device;
		for (const [rel, theirs] of Object.entries(snap.files).sort(([a], [b]) => a.localeCompare(b))) {
			const kind = scope(rel)?.kind;
			if (!kind || input.paused.has(rel)) continue;
			const mine = state.entries[rel];
			if (!mine) {
				if (theirs.h === null) { state.entries[rel] = copyEntry(theirs); continue; }
				if (await apply(rel, theirs)) { state.entries[rel] = copyEntry(theirs); agree(peer, rel, theirs.h); }
				continue;
			}
			const order = compareVv(mine.vv, theirs.vv);
			if (order === "after" || (order === "equal" && (mine.h === theirs.h || kind === "file"))) {
				if (mine.h === theirs.h || order === "after") agree(peer, rel, theirs.h);
				continue;
			}
			if (order === "before") {
				if (await apply(rel, theirs)) { state.entries[rel] = copyEntry(theirs); agree(peer, rel, theirs.h); clearFor(rel); }
				continue;
			}
			// Same vector, different content (ledger/positions merged on two
			// devices at once): both settle on the same one deterministically.
			if (order === "equal") {
				if ((theirs.h ?? "") > (mine.h ?? "") && await apply(rel, theirs)) state.entries[rel] = copyEntry(theirs);
				agree(peer, rel, state.entries[rel]!.h);
				continue;
			}
			// Both changed since they last agreed.
			if (mine.h === theirs.h) { state.entries[rel] = { h: mine.h, vv: maxVv(mine.vv, theirs.vv) }; agree(peer, rel, mine.h); clearFor(rel); continue; }
			if (kind === "file") {
				if (fileConflict(rel)) continue; // still waiting for the learner
				const conflict: PeerConflict = { id: conflictId(rel), rel, peer, ...(mine.h === null ? { deletedOn: "local" as const } : theirs.h === null ? { deletedOn: "remote" as const } : {}),
					remoteDevice: await deviceName(folder, peer, result), remoteAt: snap.at, detectedAt: now() };
				open.set(conflict.id, conflict); result.conflicts.push(conflict);
				continue;
			}
			const remoteBytes = await contentOf(theirs.h);
			if (remoteBytes === undefined) { result.waiting.push(rel); continue; }
			const baseHash = state.agreed[peer]?.[rel] ?? null;
			const baseBytes = baseHash ? (await contentOf(baseHash)) ?? null : null;
			const localBytes = mine.h ? await local.read(rel) : null;
			const text = (b: Buffer | null | undefined) => b?.toString("utf8") ?? null;
			let merged: Buffer;
			let blocked = false;
			if (kind === "positions") merged = Buffer.from(mergePositions(text(baseBytes), text(localBytes), text(remoteBytes)));
			else {
				const held = heldIds(rel);
				const out = mergeLedger(text(baseBytes), text(localBytes), text(remoteBytes), held);
				merged = Buffer.from(out.local);
				for (const c of out.conflicts) {
					const conflict: PeerConflict = { id: conflictId(rel, c.id), rel, recordId: c.id, deletedOn: c.deletedOn, peer, remoteDevice: await deviceName(folder, peer, result), remoteAt: snap.at, detectedAt: now() };
					open.set(conflict.id, conflict); result.conflicts.push(conflict);
				}
				blocked = held.size > 0 || out.conflicts.length > 0;
			}
			const mergedHash = hashBytes(merged);
			if (mergedHash !== mine.h) { await local.write(rel, merged); cache.put(merged); localMap.set(rel, mergedHash); result.pulled.push(rel); }
			if (blocked) {
				// Records still in conflict: stay "both changed" so the other
				// device keeps its own lines for them until the learner decides.
				if (mergedHash !== mine.h) state.entries[rel] = { h: mergedHash, vv: bumpVv(mine.vv, me) };
			} else if (mergedHash === theirs.h) {
				state.entries[rel] = { h: theirs.h, vv: maxVv(mine.vv, theirs.vv) }; agree(peer, rel, theirs.h);
			} else if (mergedHash === mine.h) {
				state.entries[rel] = { h: mine.h, vv: maxVv(mine.vv, theirs.vv) }; // they take ours next
			} else {
				state.entries[rel] = { h: mergedHash, vv: bumpVv(maxVv(mine.vv, theirs.vv), me) };
			}
			await upload(rel, state.entries[rel]!, merged);
		}
	}

	// 3. Publish this device's view (only when it changed).
	const files: Record<string, PeerEntry> = {};
	for (const [rel, entry] of Object.entries(state.entries).sort(([a], [b]) => a.localeCompare(b))) {
		if (!scope(rel)) continue;
		if (entry.h && !state.uploaded[entry.h]) continue; // its content is not stored yet
		files[rel] = entry;
	}
	const published = JSON.stringify(files);
	if (published !== state.published) {
		await folder.writeSnapshot({ format: PEER_FORMAT, device: me, at: now(), files });
		state.published = published;
	}
	const due = !state.deviceWrittenAt || Date.now() - Date.parse(state.deviceWrittenAt) > DEVICE_REFRESH_MS;
	if (due) { state.deviceWrittenAt = now(); await folder.writeDevice({ id: me, name: input.deviceName, lastSeen: state.deviceWrittenAt }); }
	result.devices = await folder.listDevices();
	return result;
}

async function deviceName(folder: PeerSyncFolder, id: string, result: PeerCycleResult): Promise<string> {
	if (!result.devices.length) result.devices = await folder.listDevices();
	return result.devices.find(d => d.id === id)?.name ?? "another device";
}

/** The other device's current version of a file (conflict previews). */
export async function peerVersion(folder: PeerSyncFolder, peer: string, rel: string): Promise<{ entry: PeerEntry; bytes: Buffer | null } | null> {
	const snap = await folder.readSnapshot(peer);
	const entry = snap?.files[rel];
	if (!entry) return null;
	return { entry, bytes: entry.h ? await folder.readBlob(entry.h) : null };
}

/**
 * Resolve one conflict with a peer. Whole files: the chosen content becomes a
 * version newer than both, so every device takes it. Graph records: the merge
 * base is adjusted so the next merge carries out the decision.
 */
export async function resolvePeerConflict(conflict: PeerConflict, choice: "local" | "remote" | "both", sides: {
	folder: PeerSyncFolder; local: LocalSide; cache: ContentCache; state: PeerState; deviceId: string;
	copyRel?: (bytes: Buffer) => { rel: string; bytes: Buffer };
}): Promise<void> {
	const { folder, local, cache, state, deviceId: me } = sides;
	const rel = conflict.rel;
	const theirs = await peerVersion(folder, conflict.peer, rel);
	const mine = state.entries[rel] ?? { h: null, vv: {} };
	const theirEntry = theirs?.entry ?? { h: null, vv: {} };
	if (theirEntry.h && !theirs?.bytes) throw new Error("The other device's version has not arrived on this device yet. Try again in a moment.");
	if (conflict.recordId) {
		const id = conflict.recordId;
		const localText = (await local.read(rel))?.toString("utf8") ?? null;
		const remoteText = theirs?.bytes?.toString("utf8") ?? null;
		const baseHash = state.agreed[conflict.peer]?.[rel] ?? null;
		const baseText = (baseHash ? cache.get(baseHash) ?? await folder.readBlob(baseHash) : null)?.toString("utf8") ?? null;
		const linesOf = (text: string | null, keep: (line: string) => boolean) => (text ?? "").split("\n").filter(l => l.trim() && keep(l));
		const others = (text: string | null) => linesOf(text, l => ledgerLineId(l) !== id);
		const ofId = (text: string | null) => linesOf(text, l => ledgerLineId(l) === id);
		const render = (list: string[]) => list.length ? `${list.join("\n")}\n` : "";
		let nextLocal = localText ?? "";
		let nextBase: string;
		if (choice === "remote") {
			nextLocal = render([...others(localText), ...ofId(remoteText)]);
			nextBase = render(others(baseText)); // nothing for this id: both sides now hold the same lines
		} else if (conflict.deletedOn === "local") {
			// Keep this device's deletion: their lines become the base, so they read as deleted here.
			nextBase = render([...others(baseText), ...ofId(remoteText)]);
		} else {
			// Keep this device's lines (they deleted it): absent from the base, so ours read as an addition.
			nextBase = render(others(baseText));
		}
		const localBytes = Buffer.from(nextLocal), baseBytes = Buffer.from(nextBase);
		if (localText !== nextLocal) await local.write(rel, localBytes);
		cache.put(localBytes); cache.put(baseBytes);
		(state.agreed[conflict.peer] ??= {})[rel] = hashBytes(baseBytes);
		state.entries[rel] = { h: hashBytes(localBytes), vv: bumpVv(mine.vv, me) };
		return;
	}
	if (choice === "both") {
		if (!theirs?.bytes || !sides.copyRel) throw new Error("Keeping both needs two versions of a session");
		const copy = sides.copyRel(theirs.bytes);
		await local.write(copy.rel, copy.bytes); // the next cycle publishes the new session
	}
	const winnerBytes = choice === "remote" ? theirs?.bytes ?? null : await local.read(rel);
	if (winnerBytes) await local.write(rel, winnerBytes);
	else await local.remove(rel);
	const h = winnerBytes ? hashBytes(winnerBytes) : null;
	state.entries[rel] = { h, vv: bumpVv(maxVv(mine.vv, theirEntry.vv), me) };
	if (h && winnerBytes) { await folder.writeBlob(h, winnerBytes); state.uploaded[h] = true; }
}

/** Remove blobs no snapshot refers to, once they are older than the grace
 *  period (a blob may be written before the snapshot that names it). */
export async function collectPeerGarbage(folder: PeerSyncFolder, graceMs = BLOB_GRACE_MS): Promise<number> {
	if (!folder.store.age) return 0;
	const referenced = new Set<string>();
	for (const device of await folder.snapshotDevices()) {
		const file = await folder.readSnapshotFile(device);
		if (!file || !Array.isArray(file.refs)) return 0; // unreadable: do not guess what it needs
		for (const ref of file.refs) referenced.add(ref);
	}
	let removed = 0;
	for (const name of await folder.listBlobs()) {
		if (referenced.has(name)) continue;
		const age = await folder.store.age(`${folder.root}/blobs/${name}`);
		if (age !== null && age > graceMs) { await folder.removeBlob(name); removed++; }
	}
	return removed;
}
