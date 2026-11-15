/**
 * DEVICE SYNC — the real filesystem sides. Local = the data dir (in-scope
 * files only, atomic writes through the stores' own primitive). Base = each
 * synced file's last-synced bytes under the sync dir (never inside data).
 */
import * as fs from "node:fs";
import path from "node:path";
import { removeLeftoverTemps, writeFileAtomicSync } from "../store/atomic-write.ts";
import type { BaseSide, LocalSide } from "./engine.ts";
import { hashBytes } from "./merge.ts";
import { inSyncScope, type SyncToggles } from "./scope.ts";

function walk(root: string, visit: (rel: string, abs: string, stat: fs.Stats) => void, prefix = ""): void {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const abs = path.join(root, rel);
		if (entry.isSymbolicLink()) continue; // never follow links out of the data dir
		if (entry.isDirectory()) walk(root, visit, rel);
		else if (entry.isFile()) { try { visit(rel, abs, fs.statSync(abs)); } catch { /* vanished */ } }
	}
}

function resolveInside(root: string, rel: string): string {
	const abs = path.resolve(root, ...rel.split("/"));
	if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes the data dir: ${rel}`);
	return abs;
}

export class FsLocalSide implements LocalSide {
	private hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();
	constructor(private root: string, private toggles: () => SyncToggles) {}

	async list(): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		walk(this.root, (rel, abs, stat) => {
			if (!inSyncScope(rel, this.toggles())) return;
			const cached = this.hashes.get(rel);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { out.set(rel, cached.hash); return; }
			try {
				const hash = hashBytes(fs.readFileSync(abs));
				this.hashes.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
				out.set(rel, hash);
			} catch { /* vanished mid-scan */ }
		});
		return out;
	}
	async read(rel: string): Promise<Buffer | null> {
		try { return fs.readFileSync(resolveInside(this.root, rel)); } catch { return null; }
	}
	async write(rel: string, bytes: Buffer): Promise<void> {
		const abs = resolveInside(this.root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		writeFileAtomicSync(abs, bytes); // byte-exact: hashes must match the endpoint's
		this.hashes.delete(rel);
	}
	async remove(rel: string): Promise<void> {
		const abs = resolveInside(this.root, rel);
		try { fs.unlinkSync(abs); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
		removeLeftoverTemps(abs);
		this.hashes.delete(rel);
	}
}

export class FsBaseSide implements BaseSide {
	constructor(private root: string) {}
	private file(rel: string) { return resolveInside(this.root, rel); }
	read(rel: string): Buffer | null { try { return fs.readFileSync(this.file(rel)); } catch { return null; } }
	hash(rel: string): string | null { const bytes = this.read(rel); return bytes ? hashBytes(bytes) : null; }
	set(rel: string, bytes: Buffer | null): void {
		const file = this.file(rel);
		if (bytes === null) { try { fs.unlinkSync(file); } catch { /* absent */ } return; }
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, bytes);
	}
	list(): string[] { const out: string[] = []; walk(this.root, rel => out.push(rel)); return out; }
	clear(): void { fs.rmSync(this.root, { recursive: true, force: true }); }
}

/** Copy every syncable file (all categories) into `dest` — the pre-sync
 *  safety backup and the set-aside snapshot. Returns the file count. */
export function snapshotDataDir(root: string, dest: string, opts: { move?: boolean } = {}): number {
	let count = 0;
	const all: SyncToggles = { layout: true, settings: true, plugins: true, promptsThemes: true };
	walk(root, (rel, abs) => {
		if (!inSyncScope(rel, all)) return;
		const target = path.join(dest, ...rel.split("/"));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(abs, target);
		if (opts.move) fs.unlinkSync(abs);
		count++;
	});
	return count;
}

/** Files of a snapshot, data-relative. */
export function listSnapshot(dir: string): string[] { const out: string[] = []; walk(dir, rel => out.push(rel)); return out; }
