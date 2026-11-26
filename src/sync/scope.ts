/**
 * DEVICE SYNC — what syncs (owner, 2026-11-15). Paths are data-dir relative
 * with "/" separators. Progress always syncs; the rest is per-device opt-in.
 * Anything unlisted (debug artifacts, temps, unknown files) never syncs, and
 * secrets live outside the data dir entirely (auth.json, credentials).
 */
export type SyncCategory = "progress" | "layout" | "settings" | "plugins" | "promptsThemes" | "cheatsheets";
export type OptionalSyncCategory = Exclude<SyncCategory, "progress">;
export const OPTIONAL_SYNC_CATEGORIES: readonly OptionalSyncCategory[] = ["layout", "settings", "plugins", "promptsThemes", "cheatsheets"];

/** How a unit merges: whole files (3-way, conflicts asked), append ledgers
 *  (line union, conflict-free except delete-vs-add), or layout positions
 *  (per node, newest wins silently — owner-approved). */
export type SyncUnitKind = "file" | "ledger" | "positions";

export interface SyncScopeEntry {
	category: SyncCategory;
	kind: SyncUnitKind;
}

const LEDGERS = new Set(["graph/nodes.jsonl", "graph/chains.jsonl", "graph/sessions.jsonl", "graph/coverage.jsonl"]);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Classify one data-relative path; null = never synced. */
export function classifySyncPath(rel: string): SyncScopeEntry | null {
	const segments = rel.split("/");
	// No traversal, hidden files, temps or odd names ever cross the wire.
	if (!segments.length || segments.some(s => !SAFE_SEGMENT.test(s) || s.startsWith(".") || s.includes(".tmp-"))) return null;
	if (LEDGERS.has(rel)) return { category: "progress", kind: "ledger" };
	if (rel === "graph/sources.json" || rel === "graph/format.json") return { category: "progress", kind: "file" };
	if (segments.length === 2 && (segments[0] === "chats" || segments[0] === "jobs") && segments[1]!.endsWith(".json")) return { category: "progress", kind: "file" };
	if (rel === "graph/positions.json") return { category: "layout", kind: "positions" };
	// Cheat sheets (owner, 2026-11-26): their own toggle, merged like sessions.
	if (segments.length === 2 && segments[0] === "cheatsheets" && segments[1]!.endsWith(".md")) return { category: "cheatsheets", kind: "file" };
	if (rel === "settings.json" || rel === "graph/render-settings.json") return { category: "settings", kind: "file" };
	if (rel === "plugins-state.json" || segments[0] === "plugins" || segments[0] === "core-plugin-data") return segments.length > 1 || rel === "plugins-state.json" ? { category: "plugins", kind: "file" } : null;
	if ((segments[0] === "prompts" || segments[0] === "themes") && segments.length > 1) return { category: "promptsThemes", kind: "file" };
	return null;
}

export type SyncToggles = Record<OptionalSyncCategory, boolean>;
export const DEFAULT_SYNC_TOGGLES: SyncToggles = { layout: true, settings: true, plugins: true, promptsThemes: true, cheatsheets: true };

/** Is this path synced on this device, given its toggles? */
export function inSyncScope(rel: string, toggles: SyncToggles): SyncScopeEntry | null {
	const entry = classifySyncPath(rel);
	if (!entry) return null;
	return entry.category === "progress" || toggles[entry.category] ? entry : null;
}
