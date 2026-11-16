/**
 * DEVICE-ONLY STORE (owner, 2026-11-16): small per-device documents the
 * browser cannot keep — the desktop server's port (hence the page origin)
 * changes every launch, wiping localStorage/IndexedDB. Lives in DEVICE_DIR,
 * outside the data dir, so Device Sync never sees it.
 *
 * Keys are an allowlist, never paths: "keymap", or a composer draft key
 * ("chat:<id>", "new:<mode>", "home:<mode>", "opening:<id>").
 */
import * as fs from "node:fs";
import path from "node:path";
import { DEVICE_DIR } from "../../config.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../store/atomic-write.ts";

/** Draft payloads carry base64 images: generous, but bounded. */
export const MAX_DEVICE_DOCUMENT_BYTES = 25 * 1024 * 1024; // under the API guard's 26 MiB body cap

const DRAFT_KEY = /^(chat|opening):[A-Za-z0-9_-]{1,80}$|^(new|home):(teach|practice)$/;

/** Allowlisted key → file inside DEVICE_DIR; null = refused. */
export function deviceDocumentPath(key: string): string | null {
	if (key === "keymap") return path.join(DEVICE_DIR, "keymap.json");
	if (DRAFT_KEY.test(key)) return path.join(DEVICE_DIR, "drafts", `${key.replace(":", "__")}.json`);
	return null;
}

export function readDeviceDocument(key: string): string | null {
	const file = deviceDocumentPath(key);
	if (!file) throw new Error("Unknown device document");
	try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

export function writeDeviceDocument(key: string, text: string): void {
	const file = deviceDocumentPath(key);
	if (!file) throw new Error("Unknown device document");
	if (Buffer.byteLength(text) > MAX_DEVICE_DOCUMENT_BYTES) throw new Error("Device document too large");
	JSON.parse(text); // only JSON documents are stored
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, text);
}

export function deleteDeviceDocument(key: string): void {
	const file = deviceDocumentPath(key);
	if (!file) throw new Error("Unknown device document");
	try { fs.unlinkSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
	removeLeftoverTemps(file);
}
