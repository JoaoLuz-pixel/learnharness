/**
 * DEVICE SYNC — a FolderStore on this computer's disk (owner, 2026-11-28):
 * a cloud folder (OneDrive, iCloud Drive, Dropbox…) that the provider's own
 * app copies to the other devices, or the built-in host's own storage.
 *
 * Writes go to a hidden temp file in the same folder, then a rename, so the
 * cloud app (and other readers) see old or new bytes, never a torn file.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FolderStore } from "./peer.ts";

/** The folder created inside the folder the learner picks. */
export const CLOUD_SYNC_FOLDER = "LearnHarness Sync";
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export class LocalFolderStore implements FolderStore {
	readonly root: string;
	constructor(root: string) { this.root = path.resolve(root); }

	private abs(rel: string): string {
		const parts = rel.split("/");
		if (!parts.length || parts.some(p => !SEGMENT.test(p) || p.startsWith("."))) throw new Error(`Unsafe sync path ${rel}`);
		return path.join(this.root, ...parts);
	}
	async read(rel: string): Promise<Buffer | null> {
		try { return await fs.promises.readFile(this.abs(rel)); }
		catch (err) { if (isMissing(err)) return null; throw err; }
	}
	async write(rel: string, bytes: Buffer): Promise<void> {
		const file = this.abs(rel);
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		const temp = path.join(path.dirname(file), `.lh-tmp-${randomUUID()}`);
		await fs.promises.writeFile(temp, bytes);
		try { await fs.promises.rename(temp, file); }
		catch (err) { await fs.promises.rm(temp, { force: true }); throw err; }
	}
	async create(rel: string, bytes: Buffer): Promise<void> {
		try { await fs.promises.access(this.abs(rel)); return; } catch { /* absent: write it */ }
		await this.write(rel, bytes);
	}
	async remove(rel: string): Promise<void> {
		try { await fs.promises.unlink(this.abs(rel)); } catch (err) { if (!isMissing(err)) throw err; }
	}
	async list(dir: string): Promise<string[]> {
		try { return (await fs.promises.readdir(this.abs(dir))).filter(name => !name.startsWith(".") && SEGMENT.test(name)); }
		catch (err) { if (isMissing(err)) return []; throw err; }
	}
	async age(rel: string): Promise<number | null> {
		try { return Date.now() - (await fs.promises.stat(this.abs(rel))).mtimeMs; } catch { return null; }
	}
}

function isMissing(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** The store for a cloud folder the learner picked. Refuses a folder that
 *  is not there (the cloud app is not installed, or a drive is missing). */
export function cloudFolderStore(picked: string): LocalFolderStore {
	const resolved = path.resolve(picked);
	let stat: fs.Stats;
	try { stat = fs.statSync(resolved); } catch { throw new Error("That folder could not be found. Check that your cloud app is installed and signed in."); }
	if (!stat.isDirectory()) throw new Error("Choose a folder, not a file.");
	return new LocalFolderStore(path.join(resolved, CLOUD_SYNC_FOLDER));
}

/** Folders that look like a cloud app's synced folder on this computer. */
export interface CloudFolderSuggestion { provider: "OneDrive" | "iCloud Drive" | "Dropbox" | "Google Drive"; path: string }

export function suggestCloudFolders(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): CloudFolderSuggestion[] {
	const candidates: CloudFolderSuggestion[] = [];
	const add = (provider: CloudFolderSuggestion["provider"], value: string | undefined) => { if (value) candidates.push({ provider, path: value }); };
	add("OneDrive", env.OneDriveConsumer);
	add("OneDrive", env.OneDriveCommercial);
	add("OneDrive", env.OneDrive);
	add("OneDrive", path.join(home, "OneDrive"));
	if (platform === "darwin") {
		add("iCloud Drive", path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"));
		add("OneDrive", path.join(home, "Library", "CloudStorage", "OneDrive-Personal"));
	} else {
		add("iCloud Drive", path.join(home, "iCloudDrive"));
	}
	add("Dropbox", path.join(home, "Dropbox"));
	add("Google Drive", path.join(home, "Google Drive"));
	if (platform === "win32") add("Google Drive", "G:\\My Drive");
	const seen = new Set<string>();
	return candidates.filter(c => {
		const key = path.resolve(c.path).toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		try { return fs.statSync(c.path).isDirectory(); } catch { return false; }
	});
}
