/**
 * DEVICE SYNC — remembered sync keys (owner, 2026-11-28: typed once, then
 * remembered on the device). Each password-protected sync's 32-byte key is
 * kept in SYNC_DIR/secrets.json, encrypted by the system's secure storage
 * (Windows DPAPI, macOS Keychain, the Linux keyring) through the desktop
 * shell. Outside the desktop app (dev in a browser), or where the system
 * offers no secure storage, the key is stored as is in that file, readable
 * by this user only (mode 0600).
 *
 * Also the shell's "hosting" signal: while the built-in host runs, closing
 * the window keeps the app in the tray.
 */
import * as fs from "node:fs";
import path from "node:path";
import { SYNC_DIR } from "../../config.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

const CHANNEL = "lh:sync";
interface StoredSecret { kind: "system" | "file"; value: string }
interface SecretsFile { version: 1; keys: Record<string, StoredSecret> }

const file = () => path.join(SYNC_DIR, "secrets.json");
function readFile(): SecretsFile {
	try {
		const value = JSON.parse(fs.readFileSync(file(), "utf8")) as SecretsFile;
		if (value?.version === 1 && value.keys && typeof value.keys === "object") return value;
	} catch { /* absent */ }
	return { version: 1, keys: {} };
}
function writeFile(value: SecretsFile): void {
	fs.mkdirSync(SYNC_DIR, { recursive: true });
	writeFileAtomicSync(file(), JSON.stringify(value, null, "\t"), { mode: 0o600 });
}

function desktopConnected(): boolean {
	return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && typeof process.send === "function" && process.connected === true;
}

interface Bridge { counter: number; pending: Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> }
const KEY = Symbol.for("lh.sync.bridge");
function bridge(): Bridge {
	const g = globalThis as typeof globalThis & { [KEY]?: Bridge };
	if (!g[KEY]) {
		const state: Bridge = { counter: 0, pending: new Map() };
		g[KEY] = state;
		process.on("message", (raw: unknown) => {
			const message = raw as { channel?: string; id?: string; ok?: boolean; error?: string } & Record<string, unknown>;
			if (message?.channel !== CHANNEL || typeof message.id !== "string") return;
			const waiting = state.pending.get(message.id);
			if (!waiting) return;
			clearTimeout(waiting.timer); state.pending.delete(message.id);
			if (message.ok) waiting.resolve(message);
			else waiting.reject(new Error(message.error ?? "The desktop app could not use secure storage."));
		});
	}
	return g[KEY];
}
function ask(op: "seal" | "open", fields: Record<string, unknown>): Promise<Record<string, unknown>> {
	const state = bridge();
	return new Promise((resolve, reject) => {
		const id = `${process.pid}:sync:${++state.counter}`;
		const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("The desktop app did not answer.")); }, 15_000);
		state.pending.set(id, { resolve, reject, timer });
		process.send!({ ...fields, channel: CHANNEL, id, op }, (error) => {
			if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error("The desktop connection closed.")); }
		});
	});
}

const cache = new Map<string, Buffer>();

export async function rememberSyncKey(syncId: string, master: Buffer): Promise<void> {
	let stored: StoredSecret = { kind: "file", value: master.toString("base64") };
	if (desktopConnected()) {
		const reply = await ask("seal", { value: master.toString("base64") });
		if (typeof reply.sealed === "string") stored = { kind: "system", value: reply.sealed };
	}
	const all = readFile();
	all.keys[syncId] = stored;
	writeFile(all);
	cache.set(syncId, master);
}

export async function recallSyncKey(syncId: string): Promise<Buffer | null> {
	const hit = cache.get(syncId);
	if (hit) return hit;
	const stored = readFile().keys[syncId];
	if (!stored) return null;
	let master: Buffer | null = null;
	if (stored.kind === "file") master = Buffer.from(stored.value, "base64");
	else if (desktopConnected()) {
		const reply = await ask("open", { sealed: stored.value });
		if (typeof reply.value === "string") master = Buffer.from(reply.value, "base64");
	}
	if (!master || master.length !== 32) return null;
	cache.set(syncId, master);
	return master;
}

export function forgetSyncKey(syncId?: string): void {
	const all = readFile();
	if (syncId) { delete all.keys[syncId]; cache.delete(syncId); }
	else { all.keys = {}; cache.clear(); }
	writeFile(all);
}

/** Tell the desktop shell whether this device is hosting (tray behavior). */
export function announceHosting(hosting: boolean): void {
	if (!desktopConnected()) return;
	try { process.send!({ channel: CHANNEL, op: "hosting", hosting }, () => {}); } catch { /* shell gone */ }
}
