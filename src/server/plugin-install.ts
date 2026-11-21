/**
 * Community plugins from a .zip, and updates from GitHub releases (owner,
 * 2026-11-21). Only READY-BUILT packages are accepted: nothing is ever run
 * here (no npm, no build scripts, no plugin code); files are only checked
 * and copied. A plugin's code runs only once the learner enables it.
 *
 * Install never replaces an existing plugin (owner: refuse and warn); the
 * one way to replace one is Update, from the plugin's own GitHub releases
 * (manifest "repository"), which keeps its data/ folder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { PATHS } from "../../config.ts";
import packageJson from "../../package.json";
import corePluginIds from "../../core-plugins.json";
import { parsePluginManifest, PLUGIN_ID_PATTERN, type PluginManifest } from "../core/plugins.ts";

export const MAX_PLUGIN_ZIP_BYTES = 25 * 1024 * 1024; // under the API body cap
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const SAFE_SEGMENT = /^[A-Za-z0-9._@+ ()-]+$/;
const IGNORED = (name: string) => name.startsWith("__MACOSX/") || name.split("/").some(s => s === ".DS_Store" || s === "Thumbs.db");

export class PluginInstallError extends Error {
	constructor(message: string, readonly code: "invalid" | "source-only" | "duplicate" | "reserved" | "too-large" | "not-newer" | "mismatch" = "invalid") { super(message); }
}

export interface PluginPackage {
	manifest: PluginManifest;
	/** The optional GitHub repository named in the manifest ("owner/repo"). */
	repository?: string;
	/** Files relative to the package root (what becomes <id>/dist/). */
	files: Map<string, Uint8Array>;
}
export interface PluginPackageSummary {
	id: string; name: string; version: string; minAppVersion: string;
	author?: string; description?: string; repository?: string;
	frontend: boolean; backend: boolean;
}
export const summarize = (pkg: PluginPackage): PluginPackageSummary => ({
	id: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version, minAppVersion: pkg.manifest.minAppVersion,
	...(pkg.manifest.author ? { author: pkg.manifest.author } : {}), ...(pkg.manifest.description ? { description: pkg.manifest.description } : {}),
	...(pkg.repository ? { repository: pkg.repository } : {}), frontend: !!pkg.manifest.main, backend: !!pkg.manifest.backend,
});

/** "owner/repo" or a github.com URL → "owner/repo"; anything else → undefined. */
export function githubRepository(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = value.trim().match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/);
	if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") return undefined;
	return `${match[1]}/${match[2]}`;
}

/** x.y.z comparison; non-versions compare as equal (never "newer"). */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
	const x = parse(a), y = parse(b);
	if (!x || !y) return 0;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
	return 0;
}

function safeEntryName(name: string): string | null {
	if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
	const segments = name.split("/");
	if (segments.some(s => !s || s === "." || s === ".." || !SAFE_SEGMENT.test(s))) return null;
	return name;
}

/**
 * Check a zip WITHOUT running anything. The package root is the folder
 * holding manifest.json: the zip's top level, its dist/, or the same inside
 * one wrapping folder (how GitHub and most zip tools pack a folder).
 */
export function inspectPluginZip(bytes: Uint8Array, appVersion: string = packageJson.version): PluginPackage {
	if (bytes.byteLength > MAX_PLUGIN_ZIP_BYTES) throw new PluginInstallError("This zip is larger than 25 MB.", "too-large");
	let entries: Record<string, Uint8Array>;
	let count = 0, unpacked = 0;
	try {
		entries = unzipSync(bytes, { filter: file => {
			if (++count > MAX_ENTRIES) throw new PluginInstallError("This zip holds too many files for a plugin.", "too-large");
			unpacked += file.originalSize;
			if (unpacked > MAX_UNPACKED_BYTES) throw new PluginInstallError("This zip unpacks to more than 100 MB.", "too-large");
			return !file.name.endsWith("/") && !IGNORED(file.name);
		} });
	} catch (err) {
		if (err instanceof PluginInstallError) throw err;
		throw new PluginInstallError("This file is not a readable .zip archive.");
	}
	const names = Object.keys(entries);
	for (const name of names) if (!safeEntryName(name)) throw new PluginInstallError(`Refused: the zip contains an unsafe path (${name.slice(0, 80)}).`);
	const tops = new Set(names.map(n => n.split("/")[0]!));
	const wrapper = tops.size === 1 && names.every(n => n.includes("/")) ? `${[...tops][0]}/` : "";
	const prefix = [wrapper, `${wrapper}dist/`, "", "dist/"].find(p => entries[`${p}manifest.json`] !== undefined);
	if (prefix === undefined) {
		const source = names.some(n => n === `${wrapper}package.json` || n === "package.json");
		throw new PluginInstallError(source
			? "This zip holds a plugin's source code, not a built plugin. Build it first (npm run build) and zip its dist folder, or download the plugin's release zip."
			: "No plugin found: the zip has no manifest.json.", source ? "source-only" : "invalid");
	}
	let raw: Record<string, unknown>;
	try { raw = JSON.parse(new TextDecoder().decode(entries[`${prefix}manifest.json`])) as Record<string, unknown>; }
	catch { throw new PluginInstallError("The plugin's manifest.json is not valid JSON."); }
	if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !PLUGIN_ID_PATTERN.test(raw.id)) throw new PluginInstallError("The plugin's manifest has no valid id (lowercase letters, digits and hyphens).");
	let manifest: PluginManifest;
	try { manifest = parsePluginManifest(raw, raw.id, appVersion); }
	catch (err) { throw new PluginInstallError(`This plugin can't be installed: ${(err as Error).message}.`); }
	if ((corePluginIds as string[]).includes(manifest.id)) throw new PluginInstallError(`“${manifest.id}” is reserved for a Core plugin.`, "reserved");
	const files = new Map<string, Uint8Array>();
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const rel = name.slice(prefix.length);
		if (rel === "data" || rel.startsWith("data/")) continue; // never ship data
		files.set(rel, entries[name]!);
	}
	for (const entry of [manifest.main, manifest.backend, manifest.styles]) {
		if (entry && !files.has(entry)) throw new PluginInstallError(`The plugin is incomplete: ${entry} is missing.`);
	}
	const repository = githubRepository(raw.repository);
	return { manifest, files, ...(repository ? { repository } : {}) };
}

/* ── filesystem ── */

export interface InstallPaths { pluginDirectory: string; stagingDirectory: string }
export const defaultInstallPaths = (): InstallPaths => ({
	pluginDirectory: path.join(/* turbopackIgnore: true */ PATHS.data, "plugins"),
	// A SIBLING of plugins/: every folder inside plugins/ is read as a plugin.
	stagingDirectory: path.join(/* turbopackIgnore: true */ PATHS.data, ".plugin-install"),
});

/** The installed package's manifest (raw JSON), or null. */
export function installedManifest(id: string, paths: InstallPaths = defaultInstallPaths()): Record<string, unknown> | null {
	if (!PLUGIN_ID_PATTERN.test(id)) return null;
	try { return JSON.parse(fs.readFileSync(path.join(paths.pluginDirectory, id, "dist", "manifest.json"), "utf8")) as Record<string, unknown>; }
	catch { return null; }
}

function stage(pkg: PluginPackage, paths: InstallPaths): string {
	const dir = path.join(paths.stagingDirectory, randomUUID());
	for (const [rel, bytes] of pkg.files) {
		const target = path.join(dir, ...rel.split("/"));
		if (!target.startsWith(dir + path.sep)) throw new PluginInstallError("Refused: unsafe path in the zip.");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, bytes);
	}
	return dir;
}

/** Refuse (and say so) when this plugin is already installed. Checked as
 *  soon as a zip is inspected, so no install dialog opens for a duplicate. */
export function assertNotInstalled(id: string, paths: InstallPaths = defaultInstallPaths()): void {
	if (!fs.existsSync(path.join(paths.pluginDirectory, id))) return;
	const current = installedManifest(id, paths);
	const version = typeof current?.version === "string" ? ` v${current.version}` : "";
	throw new PluginInstallError(`${typeof current?.name === "string" ? current.name : id}${version} is already installed. To get a newer version, use Update in its entry (when it names its GitHub repository), or remove its folder first.`, "duplicate");
}

/** Install a NEW plugin. Refuses one that is already installed. */
export function installPluginPackage(pkg: PluginPackage, paths: InstallPaths = defaultInstallPaths()): void {
	const root = path.join(paths.pluginDirectory, pkg.manifest.id);
	assertNotInstalled(pkg.manifest.id, paths);
	fs.mkdirSync(paths.pluginDirectory, { recursive: true });
	const staged = stage(pkg, paths);
	try {
		fs.mkdirSync(root);
		fs.renameSync(staged, path.join(root, "dist"));
	} catch (err) {
		fs.rmSync(staged, { recursive: true, force: true });
		try { fs.rmdirSync(root); } catch { /* not empty or absent */ }
		throw err;
	}
}

/** Replace an installed plugin's code with a newer version; data/ is kept. */
export function replacePluginPackage(pkg: PluginPackage, paths: InstallPaths = defaultInstallPaths()): { from: string } {
	const id = pkg.manifest.id;
	const current = installedManifest(id, paths);
	if (!current) throw new PluginInstallError(`${id} is not installed.`, "mismatch");
	const from = typeof current.version === "string" ? current.version : "0.0.0";
	if (compareVersions(pkg.manifest.version, from) <= 0) throw new PluginInstallError(`The release is v${pkg.manifest.version}, not newer than the installed v${from}.`, "not-newer");
	const dist = path.join(paths.pluginDirectory, id, "dist");
	if (fs.lstatSync(dist).isSymbolicLink()) throw new PluginInstallError("Refused: this plugin's dist folder is a link (a development install). Update it from its source instead.");
	const staged = stage(pkg, paths);
	const backup = path.join(paths.stagingDirectory, `backup-${randomUUID()}`);
	fs.renameSync(dist, backup);
	try { fs.renameSync(staged, dist); }
	catch (err) {
		fs.renameSync(backup, dist); // put the working version back
		fs.rmSync(staged, { recursive: true, force: true });
		throw err;
	}
	fs.rmSync(backup, { recursive: true, force: true });
	return { from };
}

/* ── GitHub releases ── */

export interface PluginUpdateInfo { id: string; current: string; repository: string; latest?: string; available: boolean; error?: string }
interface ReleaseAsset { name: string; browser_download_url: string; size: number }
type Fetch = typeof fetch;
const RELEASE_TTL_MS = 30 * 60_000;
const releaseCache = new Map<string, { at: number; value: { tag: string; assets: ReleaseAsset[] } }>();

async function latestRelease(repository: string, fetchImpl: Fetch): Promise<{ tag: string; assets: ReleaseAsset[] }> {
	const cached = releaseCache.get(repository);
	if (cached && Date.now() - cached.at < RELEASE_TTL_MS) return cached.value;
	const res = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "LearnHarness" }, signal: AbortSignal.timeout(15_000) });
	if (res.status === 404) throw new Error("No published release found on GitHub.");
	if (res.status === 403 || res.status === 429) throw new Error("GitHub is rate-limiting checks. Try again later.");
	if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
	const body = await res.json() as { tag_name?: unknown; assets?: unknown };
	const assets = Array.isArray(body.assets) ? body.assets.filter((a): a is ReleaseAsset => !!a && typeof (a as ReleaseAsset).name === "string" && typeof (a as ReleaseAsset).browser_download_url === "string") : [];
	const value = { tag: typeof body.tag_name === "string" ? body.tag_name : "", assets };
	releaseCache.set(repository, { at: Date.now(), value });
	return value;
}
export function clearReleaseCache(): void { releaseCache.clear(); }

/** The release's plugin zip: one named after the plugin, else the only zip. */
export function pickPluginAsset(id: string, assets: readonly ReleaseAsset[]): ReleaseAsset | null {
	const zips = assets.filter(a => a.name.toLowerCase().endsWith(".zip"));
	return zips.find(a => a.name.toLowerCase().startsWith(id)) ?? (zips.length === 1 ? zips[0]! : null);
}
const tagVersion = (tag: string) => { const v = tag.replace(/^v/i, ""); return /^\d+\.\d+\.\d+$/.test(v) ? v : null; };

/** Check every installed community plugin that names a GitHub repository. */
export async function checkPluginUpdates(ids: readonly string[], fetchImpl: Fetch = fetch, paths: InstallPaths = defaultInstallPaths()): Promise<PluginUpdateInfo[]> {
	const out: PluginUpdateInfo[] = [];
	for (const id of ids) {
		const manifest = installedManifest(id, paths);
		const repository = githubRepository(manifest?.repository);
		if (!manifest || !repository || typeof manifest.version !== "string") continue;
		const current = manifest.version;
		try {
			const release = await latestRelease(repository, fetchImpl);
			const latest = tagVersion(release.tag) ?? undefined;
			const asset = pickPluginAsset(id, release.assets);
			out.push({ id, current, repository, ...(latest ? { latest } : {}), available: !!latest && !!asset && compareVersions(latest, current) > 0,
				...(!asset ? { error: "The latest release has no plugin .zip attached." } : {}) });
		} catch (err) {
			out.push({ id, current, repository, available: false, error: (err as Error).message });
		}
	}
	return out;
}

/** Download the latest release's zip (github.com only, size-capped) and inspect it. */
export async function downloadPluginUpdate(id: string, fetchImpl: Fetch = fetch, paths: InstallPaths = defaultInstallPaths()): Promise<PluginPackage> {
	const manifest = installedManifest(id, paths);
	const repository = githubRepository(manifest?.repository);
	if (!repository) throw new PluginInstallError("This plugin does not name a GitHub repository, so it can't be updated from here.", "mismatch");
	const release = await latestRelease(repository, fetchImpl);
	const asset = pickPluginAsset(id, release.assets);
	if (!asset) throw new PluginInstallError("The latest release has no plugin .zip attached.");
	const url = new URL(asset.browser_download_url);
	if (url.protocol !== "https:" || url.hostname !== "github.com") throw new PluginInstallError("Refused: the release download is not on github.com.");
	if (asset.size > MAX_PLUGIN_ZIP_BYTES) throw new PluginInstallError("The release zip is larger than 25 MB.", "too-large");
	const res = await fetchImpl(url, { headers: { "User-Agent": "LearnHarness" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
	if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
	const chunks: Uint8Array[] = []; let size = 0;
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		size += chunk.byteLength;
		if (size > MAX_PLUGIN_ZIP_BYTES) throw new PluginInstallError("The release zip is larger than 25 MB.", "too-large");
		chunks.push(chunk);
	}
	const bytes = new Uint8Array(size); let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	const pkg = inspectPluginZip(bytes);
	if (pkg.manifest.id !== id) throw new PluginInstallError(`The release zip holds “${pkg.manifest.id}”, not “${id}”.`, "mismatch");
	return pkg;
}
