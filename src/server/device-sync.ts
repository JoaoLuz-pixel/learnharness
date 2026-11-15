/**
 * DEVICE SYNC — the server-side service (owner design, 2026-11-15).
 *
 * The app always works on its LOCAL files; this service keeps them merged
 * with one SSH endpoint while the learner has sync enabled: on every local
 * change (debounced) and every `intervalSec`. Losing the connection never
 * interrupts learning — the service goes "offline" and retries with backoff.
 *
 * Private state lives in SYNC_DIR (never synced): state.json, the device key,
 * base/ (last-synced bytes per file), backups/ and set-aside/ snapshots.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS, SYNC_DIR } from "../../config.ts";
import { emit, subscribe } from "../core/events.ts";
import type { ConflictDecision, DeviceSyncStatus, JoinChoice, SetAsideView, SyncConflictView, SyncInterval, SyncLockView, SyncPhase, SyncProbeResult, SyncToggleState } from "../core/device-sync.ts";
import { SYNC_INTERVALS } from "../core/device-sync.ts";
import { resolveConflict, runSyncCycle, type Manifest, type SyncConflict } from "../sync/engine.ts";
import { FsBaseSide, FsLocalSide, listSnapshot, snapshotDataDir } from "../sync/local-fs.ts";
import { ledgerLineId, mergeLedger } from "../sync/merge.ts";
import { DEFAULT_SYNC_TOGGLES, classifySyncPath } from "../sync/scope.ts";
import { generateDeviceKey, HostKeyMismatchError, SftpEndpoint, type DeviceRecord, type SessionLock } from "../sync/sftp.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { isTurnRunning } from "./turn-liveness.ts";

interface StoredConflict extends SyncConflict { label: string; kind: SyncConflictView["kind"]; localPreview?: string; remotePreview?: string }
interface SyncState {
	version: 1;
	deviceId: string;
	deviceName: string;
	toggles: SyncToggleState;
	intervalSec: SyncInterval;
	endpoint: { host: string; port: number; fingerprint: string } | null;
	enabled: boolean;
	/** This device completed its first sync with the current endpoint. */
	joined: boolean;
	conflicts: StoredConflict[];
	setAside: SetAsideView[];
	lastSyncAt: string | null;
}

const STATE_FILE = () => path.join(SYNC_DIR, "state.json");
const KEY_FILE = () => path.join(SYNC_DIR, "device_ed25519");
const BASE_DIR = () => path.join(SYNC_DIR, "base");
const LOCK_TTL_MS = 90_000;
const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];

function defaultState(): SyncState {
	return { version: 1, deviceId: `dev_${randomUUID().slice(0, 12)}`, deviceName: os.hostname() || "This device", toggles: { ...DEFAULT_SYNC_TOGGLES },
		intervalSec: 10, endpoint: null, enabled: false, joined: false, conflicts: [], setAside: [], lastSyncAt: null };
}
function loadState(): SyncState {
	try {
		const value = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<SyncState>;
		if (value.version !== 1 || typeof value.deviceId !== "string") return defaultState();
		const base = defaultState();
		return { ...base, ...value, toggles: { ...base.toggles, ...value.toggles }, intervalSec: SYNC_INTERVALS.includes(value.intervalSec as SyncInterval) ? value.intervalSec as SyncInterval : 10 } as SyncState;
	} catch { return defaultState(); }
}

/* ── previews: what a conflict IS, in learner words ── */
function chatInfo(bytes: Buffer | null): { title?: string; last?: string } {
	if (!bytes) return {};
	try {
		const chat = JSON.parse(bytes.toString("utf8")) as { title?: string; messages?: { role?: string; content?: unknown }[] };
		const lastText = [...(chat.messages ?? [])].reverse().map(m => typeof m.content === "string" ? m.content
			: Array.isArray(m.content) ? m.content.map(b => (b as { type?: string; text?: string }).type === "text" ? (b as { text: string }).text : "").join(" ") : "").find(t => t.trim());
		return { title: chat.title, last: lastText?.trim().slice(0, 160) };
	} catch { return {}; }
}
function nodeInfo(bytes: Buffer | null, id: string): { name?: string; statement?: string } {
	for (const line of (bytes?.toString("utf8") ?? "").split("\n").reverse()) {
		if (ledgerLineId(line) !== id) continue;
		try { const node = JSON.parse(line) as { name?: string; statement?: string }; return { name: node.name, statement: node.statement?.slice(0, 160) }; } catch { /* skip */ }
	}
	return {};
}

class DeviceSyncService {
	private state = loadState();
	private endpoint: SftpEndpoint | null = null;
	private phase: SyncPhase = "off";
	private lastError: string | null = null;
	private devices: DeviceRecord[] = [];
	private remoteLocks: SessionLock[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private watcher: fs.FSWatcher | null = null;
	private failures = 0;
	private cycling: Promise<void> | null = null;
	private again = false;
	private heartbeats = new Map<string, ReturnType<typeof setInterval>>();
	private local = new FsLocalSide(PATHS.data, () => this.state.toggles);
	private base = new FsBaseSide(BASE_DIR());
	private pendingJoin: JoinChoice | null = null;

	constructor() {
		subscribe((event) => {
			if (event.type === "turn-started") void this.lockSession(event.chatId);
			if (event.type === "turn-settled") { void this.unlockSession(event.chatId); this.schedule(500); }
		});
		if (this.state.enabled && this.state.endpoint && this.state.joined) this.start();
	}

	private save(): void {
		fs.mkdirSync(SYNC_DIR, { recursive: true });
		writeFileAtomicSync(STATE_FILE(), JSON.stringify(this.state, null, "\t"), { mode: 0o600 });
	}
	private changed(): void { emit("sync-changed", {}); }
	private setPhase(phase: SyncPhase, error: string | null = this.lastError): void {
		this.phase = phase; this.lastError = error; this.changed();
	}

	/* ── keys ── */
	publicKey(): string | null { try { return fs.readFileSync(`${KEY_FILE()}.pub`, "utf8").trim(); } catch { return null; } }
	generateKey(): string {
		const existing = this.publicKey();
		if (existing) return existing;
		const { privateKey, publicKey } = generateDeviceKey(`learnharness-${this.state.deviceName.replace(/[^A-Za-z0-9._-]/g, "-")}`);
		fs.mkdirSync(SYNC_DIR, { recursive: true });
		writeFileAtomicSync(KEY_FILE(), privateKey, { mode: 0o600 });
		writeFileAtomicSync(`${KEY_FILE()}.pub`, `${publicKey}\n`, { mode: 0o644 });
		this.save(); this.changed();
		return publicKey;
	}
	private privateKey(): string {
		try { return fs.readFileSync(KEY_FILE(), "utf8"); } catch { throw new Error("Generate this device's key first."); }
	}

	/* ── status ── */
	status(): DeviceSyncStatus {
		const now = Date.now();
		return {
			phase: this.phase, deviceId: this.state.deviceId, deviceName: this.state.deviceName, publicKey: this.publicKey(),
			endpoint: this.state.endpoint, enabled: this.state.enabled, toggles: this.state.toggles, intervalSec: this.state.intervalSec,
			lastSyncAt: this.state.lastSyncAt, lastError: this.lastError,
			conflicts: this.state.conflicts.map(c => ({ id: c.id, label: c.label, kind: c.kind, ...(c.deletedOn ? { deletedOn: c.deletedOn } : {}),
				...(c.remoteDevice ? { remoteDevice: c.remoteDevice } : {}), ...(c.remoteAt ? { remoteAt: c.remoteAt } : {}),
				...(c.localPreview ? { localPreview: c.localPreview } : {}), ...(c.remotePreview ? { remotePreview: c.remotePreview } : {}),
				detectedAt: c.detectedAt, canKeepBoth: c.kind === "session" && !c.deletedOn })),
			devices: this.devices.map(d => ({ ...d, self: d.id === this.state.deviceId })),
			locks: this.remoteLocks.filter(l => l.deviceId !== this.state.deviceId && Date.parse(l.expiresAt) > now).map(l => ({ chatId: l.chatId, deviceName: l.deviceName, expiresAt: l.expiresAt })),
			setAside: this.state.setAside,
		};
	}
	/** Another device is running a turn in this session (server-side gate). */
	remoteLockFor(chatId: string): SyncLockView | null {
		return this.status().locks.find(l => l.chatId === chatId) ?? null;
	}

	/* ── preferences ── */
	configure(patch: { deviceName?: string; toggles?: Partial<SyncToggleState>; intervalSec?: number }): void {
		if (typeof patch.deviceName === "string") {
			const name = patch.deviceName.trim().slice(0, 60);
			if (!name) throw new Error("Device name cannot be empty");
			this.state.deviceName = name;
		}
		if (patch.toggles) for (const key of Object.keys(DEFAULT_SYNC_TOGGLES) as (keyof SyncToggleState)[]) {
			if (typeof patch.toggles[key] === "boolean") this.state.toggles[key] = patch.toggles[key]!;
		}
		if (patch.intervalSec !== undefined) {
			if (!SYNC_INTERVALS.includes(patch.intervalSec as SyncInterval)) throw new Error("Unsupported sync interval");
			this.state.intervalSec = patch.intervalSec as SyncInterval;
		}
		this.save(); this.changed(); this.schedule(500);
	}

	/* ── connecting ── */
	/** First contact: learn the endpoint's identity without trusting it yet. */
	async probe(host: string, port: number): Promise<SyncProbeResult> {
		const endpoint = await SftpEndpoint.connect({ host, port, privateKey: this.privateKey() });
		try {
			const meta = await endpoint.readMeta();
			return { fingerprint: endpoint.fingerprint, initialized: !!meta, devices: (await endpoint.listDevices()).length };
		} finally { endpoint.close(); }
	}

	async connect(options: { host: string; port: number; fingerprint: string; join?: JoinChoice }): Promise<void> {
		const sameEndpoint = this.state.endpoint?.host === options.host && this.state.endpoint.port === options.port && this.state.endpoint.fingerprint === options.fingerprint;
		if (!sameEndpoint) { this.base.clear(); this.state.joined = false; this.state.conflicts = []; }
		this.state.endpoint = { host: options.host, port: options.port, fingerprint: options.fingerprint };
		this.pendingJoin = options.join ?? null;
		this.state.enabled = true;
		this.save();
		await this.open();
		await this.cycleNow();
		if (this.lastError) throw new Error(this.lastError);
		this.start();
	}

	disconnect(): void {
		this.state.enabled = false; this.save();
		this.stop();
		this.setPhase("off", null);
	}

	/** Forget: stop, drop the endpoint AND this device's key (owner: always). */
	forget(): void {
		this.stop();
		for (const file of [KEY_FILE(), `${KEY_FILE()}.pub`]) { try { fs.unlinkSync(file); } catch { /* absent */ } }
		this.base.clear();
		Object.assign(this.state, { endpoint: null, enabled: false, joined: false, conflicts: [], lastSyncAt: null });
		this.devices = []; this.remoteLocks = [];
		this.save();
		this.setPhase("off", null);
	}

	private async open(): Promise<SftpEndpoint> {
		if (this.endpoint) return this.endpoint;
		const target = this.state.endpoint;
		if (!target) throw new Error("No endpoint configured");
		this.setPhase("connecting");
		try {
			const endpoint = await SftpEndpoint.connect({ host: target.host, port: target.port, privateKey: this.privateKey(), pinned: target.fingerprint });
			endpoint.onClose(() => { if (this.endpoint === endpoint) { this.endpoint = null; if (this.state.enabled) { this.setPhase("offline"); this.schedule(this.backoff()); } } });
			this.endpoint = endpoint;
			this.failures = 0;
			return endpoint;
		} catch (err) {
			if (err instanceof HostKeyMismatchError) { this.setPhase("blocked", err.message); throw err; }
			this.failures++;
			this.setPhase("offline", err instanceof Error ? err.message : String(err));
			throw err;
		}
	}
	private backoff(): number { return BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!; }

	private start(): void {
		if (!this.watcher) {
			try {
				this.watcher = fs.watch(PATHS.data, { recursive: true }, (_event, name) => {
					if (name && classifySyncPath(String(name).split(path.sep).join("/"))) this.schedule(1_000);
				});
			} catch { /* no recursive watch here: the interval still syncs */ }
		}
		this.schedule(0);
	}
	private stop(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.debounce) clearTimeout(this.debounce);
		this.timer = this.debounce = null;
		this.watcher?.close(); this.watcher = null;
		for (const beat of this.heartbeats.values()) clearInterval(beat);
		this.heartbeats.clear();
		this.endpoint?.close(); this.endpoint = null;
	}
	/** Run a cycle after `delayMs` (debounced), then keep the interval going. */
	private schedule(delayMs: number): void {
		if (!this.state.enabled || !this.state.endpoint || this.phase === "blocked") return;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => { this.debounce = null; void this.cycleNow(); }, delayMs);
	}

	/** One cycle; concurrent requests coalesce into one follow-up run. */
	cycleNow(): Promise<void> {
		if (this.cycling) { this.again = true; return this.cycling; }
		this.cycling = this.cycle().finally(() => {
			this.cycling = null;
			if (this.timer) clearTimeout(this.timer);
			if (this.state.enabled && this.phase !== "blocked") this.timer = setTimeout(() => void this.cycleNow(), this.again ? 0 : this.state.intervalSec * 1000);
			this.again = false;
		});
		return this.cycling;
	}

	private async cycle(): Promise<void> {
		if (!this.state.enabled || !this.state.endpoint) return;
		let endpoint: SftpEndpoint;
		try { endpoint = await this.open(); } catch { return; }
		this.setPhase("syncing", null);
		let locked = false;
		try {
			for (let attempt = 0; attempt < 5 && !(locked = await endpoint.acquireCycleLock(this.state.deviceId)); attempt++) await new Promise(r => setTimeout(r, 1_500));
			if (!locked) { this.setPhase("in-sync"); return; } // another device is writing; the next cycle retries
			const meta = await endpoint.readMeta();
			if (!this.state.joined) {
				// Every first sync with an endpoint starts from a full local backup.
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				snapshotDataDir(PATHS.data, path.join(SYNC_DIR, "backups", stamp));
				if (!meta) await endpoint.initialize(this.state.deviceName);
				else if (this.pendingJoin === "set-aside") {
					const files = snapshotDataDir(PATHS.data, path.join(SYNC_DIR, "set-aside", stamp), { move: true });
					this.state.setAside.push({ id: stamp, createdAt: new Date().toISOString(), files });
				}
			}
			const manifest = await endpoint.readManifest();
			const running = this.runningChatHolds();
			const result = await runSyncCycle({ local: this.local, remote: endpoint, base: this.base, manifest, toggles: this.state.toggles,
				deviceName: this.state.deviceName, held: [...this.state.conflicts, ...running] });
			if (result.manifestChanged) await endpoint.writeManifest(manifest);
			for (const conflict of result.conflicts) this.state.conflicts.push(await this.describe(conflict, endpoint, manifest));
			await endpoint.registerDevice({ id: this.state.deviceId, name: this.state.deviceName, lastSeen: new Date().toISOString() });
			this.devices = await endpoint.listDevices();
			this.remoteLocks = await endpoint.listSessionLocks();
			this.state.joined = true; this.pendingJoin = null;
			this.state.lastSyncAt = new Date().toISOString();
			this.save();
			this.announce([...result.pulled, ...result.deletedLocal]);
			this.setPhase("in-sync", null);
		} catch (err) {
			if (err instanceof HostKeyMismatchError) return;
			this.endpoint?.close(); this.endpoint = null; this.failures++;
			this.setPhase("offline", err instanceof Error ? err.message : String(err));
			this.schedule(this.backoff());
		} finally {
			if (locked) await endpoint.releaseCycleLock().catch(() => undefined);
		}
	}

	/** A session running a turn HERE never takes remote changes mid-turn. */
	private runningChatHolds(): SyncConflict[] {
		const holds: SyncConflict[] = [];
		try {
			for (const name of fs.readdirSync(PATHS.chats)) {
				if (name.endsWith(".json") && isTurnRunning(name.slice(0, -5))) holds.push({ id: `running:${name}`, rel: `chats/${name}`, detectedAt: "" });
			}
		} catch { /* no chats yet */ }
		return holds;
	}

	/** Tell open views what changed underneath them (notify-then-fetch). */
	private announce(rels: string[]): void {
		if (!rels.length) return;
		let chats = false;
		for (const rel of rels) {
			const [dir, file] = rel.split("/");
			if (dir === "chats" && file) { chats = true; emit("record-changed", { chatId: file.replace(/\.json$/, "") }); }
			else if (dir === "jobs") emit("jobs-changed", {});
			else if (rel === "graph/sources.json") emit("sources-changed", {});
			else if (dir === "plugins" || dir === "core-plugin-data" || rel === "plugins-state.json") emit("plugins-changed", {});
		}
		if (chats) emit("chats-changed", {});
		emit("activity-changed", {}); // graph views re-read the mtime revision
	}

	private async describe(conflict: SyncConflict, endpoint: SftpEndpoint, manifest: Manifest): Promise<StoredConflict> {
		const localBytes = await this.local.read(conflict.rel);
		const remoteBytes = manifest.files[conflict.rel] ? await endpoint.read(conflict.rel) : null;
		if (conflict.recordId) {
			const l = nodeInfo(localBytes, conflict.recordId), r = nodeInfo(remoteBytes, conflict.recordId);
			const name = l.name ?? r.name ?? conflict.recordId;
			return { ...conflict, kind: "node", label: `Graph node “${name}”`, ...(l.statement && conflict.deletedOn !== "local" ? { localPreview: l.statement } : {}), ...(r.statement && conflict.deletedOn !== "remote" ? { remotePreview: r.statement } : {}) };
		}
		if (conflict.rel.startsWith("chats/")) {
			const l = chatInfo(localBytes), r = chatInfo(remoteBytes);
			return { ...conflict, kind: "session", label: `Session “${l.title ?? r.title ?? conflict.rel}”`, ...(l.last ? { localPreview: l.last } : {}), ...(r.last ? { remotePreview: r.last } : {}) };
		}
		const names: Record<string, string> = { "settings.json": "Settings", "graph/sources.json": "Imported notes list", "graph/render-settings.json": "Graph display settings", "plugins-state.json": "Enabled plugins" };
		return { ...conflict, kind: "other", label: names[conflict.rel] ?? conflict.rel };
	}

	/* ── conflicts ── */
	async resolve(id: string, decision: ConflictDecision): Promise<void> {
		const conflict = this.state.conflicts.find(c => c.id === id);
		if (!conflict) throw new Error("This conflict was already resolved");
		if (decision === "both" && (conflict.kind !== "session" || conflict.deletedOn)) throw new Error("Only sessions edited on both devices can keep both versions");
		const endpoint = await this.open();
		if (!await endpoint.acquireCycleLock(this.state.deviceId)) throw new Error("Another device is syncing right now. Try again in a moment.");
		try {
			const manifest = await endpoint.readManifest();
			const otherDevice = conflict.remoteDevice ?? "another device";
			await resolveConflict(conflict, decision, { local: this.local, remote: endpoint, base: this.base, manifest, deviceName: this.state.deviceName,
				copyRel: (bytes) => {
					const chat = JSON.parse(bytes.toString("utf8")) as { id: string; title?: string };
					const id = `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
					return { rel: `chats/${id}.json`, bytes: Buffer.from(JSON.stringify({ ...chat, id, title: `${chat.title ?? "Session"} (from ${otherDevice})` }, null, "\t")) };
				} });
			await endpoint.writeManifest(manifest);
			this.state.conflicts = this.state.conflicts.filter(c => c.id !== id);
			this.save();
			this.announce([conflict.rel]);
			this.changed();
		} finally { await endpoint.releaseCycleLock().catch(() => undefined); }
		this.schedule(0);
	}

	/* ── set-aside progress ── */
	restoreSetAside(id: string): void {
		const entry = this.state.setAside.find(s => s.id === id);
		if (!entry) throw new Error("Unknown set-aside snapshot");
		const dir = path.join(SYNC_DIR, "set-aside", id);
		for (const rel of listSnapshot(dir)) {
			const scope = classifySyncPath(rel);
			if (!scope) continue;
			const target = path.join(PATHS.data, ...rel.split("/"));
			const bytes = fs.readFileSync(path.join(dir, ...rel.split("/")));
			fs.mkdirSync(path.dirname(target), { recursive: true });
			if (scope.kind === "ledger") {
				const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
				writeFileAtomicSync(target, mergeLedger(null, current, bytes.toString("utf8")).local);
			} else if (!fs.existsSync(target)) writeFileAtomicSync(target, bytes); // never overwrite current progress
		}
		this.deleteSetAside(id);
		emit("chats-changed", {});
		this.schedule(500);
	}
	deleteSetAside(id: string): void {
		if (!/^[0-9TZ-]+$/.test(id)) throw new Error("Unknown set-aside snapshot");
		fs.rmSync(path.join(SYNC_DIR, "set-aside", id), { recursive: true, force: true });
		this.state.setAside = this.state.setAside.filter(s => s.id !== id);
		this.save(); this.changed();
	}

	/* ── session locks ── */
	private async lockSession(chatId: string): Promise<void> {
		if (!this.endpoint || !this.state.enabled) return;
		const write = () => this.endpoint?.writeSessionLock({ chatId, deviceId: this.state.deviceId, deviceName: this.state.deviceName, expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString() }).catch(() => undefined);
		await write();
		if (!this.heartbeats.has(chatId)) this.heartbeats.set(chatId, setInterval(() => void write(), LOCK_TTL_MS / 3));
	}
	private async unlockSession(chatId: string): Promise<void> {
		const beat = this.heartbeats.get(chatId);
		if (beat) clearInterval(beat);
		this.heartbeats.delete(chatId);
		await this.endpoint?.removeSessionLock(chatId).catch(() => undefined);
	}
}

/** One service per server process (globalThis: every Next module entry shares it). */
export function deviceSync(): DeviceSyncService {
	const g = globalThis as typeof globalThis & { __lhDeviceSync?: DeviceSyncService };
	return (g.__lhDeviceSync ??= new DeviceSyncService());
}
