/**
 * DEVICE SYNC — the pure three-way merge (owner design, 2026-11-15).
 *
 * Each device keeps its own BASE: the exact bytes it last synced. Comparing
 * base / local / remote per record tells who changed what, so deletions are
 * safe without separate deletion records (a long-offline device sees "was in
 * my base, gone remotely, untouched here" and deletes instead of re-uploading).
 *
 *  - Whole files: one side changed → that side wins; both changed → conflict
 *    (the learner decides — "ask me each time").
 *  - Append ledgers (graph *.jsonl): line union in multiset terms, so two
 *    devices adding knowledge never conflict. The only conflict is an id one
 *    side deleted entirely while the other added to it.
 *  - Layout positions: per node; both moved → the newer file wins silently.
 */
import { createHash } from "node:crypto";

export function hashBytes(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export type FileDecision = "same" | "pull" | "push" | "delete-local" | "delete-remote" | "conflict";

/** Hashes (null = absent). Equal local/remote is always "same", deletions included. */
export function decideFile(base: string | null, local: string | null, remote: string | null): FileDecision {
	if (local === remote) return "same";
	if (base === local) return remote === null ? "delete-local" : "pull";
	if (base === remote) return local === null ? "delete-remote" : "push";
	return "conflict";
}

function lines(text: string | null): string[] {
	return (text ?? "").split("\n").filter(line => line.trim().length > 0);
}
function counts(list: readonly string[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const line of list) map.set(line, (map.get(line) ?? 0) + 1);
	return map;
}
/** The record id a ledger line belongs to (nodes/chains: id; others: none). */
export function ledgerLineId(line: string): string | null {
	try {
		const value = JSON.parse(line) as { id?: unknown };
		return typeof value.id === "string" ? value.id : null;
	} catch { return null; }
}

export interface LedgerMerge {
	local: string;
	remote: string;
	base: string;
	/** Ids deleted entirely on one side while the other side added to them. */
	conflicts: { id: string; deletedOn: "local" | "remote" }[];
}

function render(list: readonly string[]): string {
	return list.length ? `${list.join("\n")}\n` : "";
}

/**
 * Merge one ledger. `held` ids (pending conflicts) do not sync: each side
 * keeps its own lines for them and the base keeps its own, so the next cycle
 * sees the same disagreement until the learner resolves it.
 */
export function mergeLedger(baseText: string | null, localText: string | null, remoteText: string | null, held: ReadonlySet<string> = new Set()): LedgerMerge {
	const base = lines(baseText), local = lines(localText), remote = lines(remoteText);
	const idOf = (line: string) => ledgerLineId(line);

	// Delete-vs-add detection, by id.
	const ids = (list: readonly string[]) => { const set = new Set<string>(); for (const l of list) { const id = idOf(l); if (id) set.add(id); } return set; };
	const baseIds = ids(base), localIds = ids(local), remoteIds = ids(remote);
	const baseSet = new Set(base);
	const addedTo = (list: readonly string[], id: string) => list.some(l => idOf(l) === id && !baseSet.has(l));
	const conflicts: LedgerMerge["conflicts"] = [];
	const newlyHeld = new Set(held);
	for (const id of baseIds) {
		if (held.has(id)) continue;
		if (!localIds.has(id) && addedTo(remote, id)) { conflicts.push({ id, deletedOn: "local" }); newlyHeld.add(id); }
		else if (!remoteIds.has(id) && addedTo(local, id)) { conflicts.push({ id, deletedOn: "remote" }); newlyHeld.add(id); }
	}
	const heldLine = (line: string) => { const id = idOf(line); return id !== null && newlyHeld.has(id); };

	// Multiset three-way on the lines that DO sync.
	const b = counts(base.filter(l => !heldLine(l))), lc = counts(local.filter(l => !heldLine(l))), rc = counts(remote.filter(l => !heldLine(l)));
	const target = new Map<string, number>();
	for (const line of new Set([...b.keys(), ...lc.keys(), ...rc.keys()])) {
		const n = b.get(line) ?? 0, l = lc.get(line) ?? 0, r = rc.get(line) ?? 0;
		target.set(line, l > n && r > n ? Math.max(l, r) : Math.max(0, l + r - n));
	}
	// Order: local's order first (the device's own truth), then remote additions.
	const merged: string[] = [];
	const emitted = new Map<string, number>();
	for (const line of [...local, ...remote]) {
		if (heldLine(line)) continue;
		const done = emitted.get(line) ?? 0;
		if (done < (target.get(line) ?? 0)) { merged.push(line); emitted.set(line, done + 1); }
	}
	const withHeld = (own: readonly string[]) => [...merged, ...own.filter(heldLine)];
	return { local: render(withHeld(local)), remote: render(withHeld(remote)), base: render(withHeld(base)), conflicts };
}

type Positions = { positions: Record<string, { x: number; y: number }>; updatedAt?: string };
function parsePositions(text: string | null): Positions {
	try {
		const value = JSON.parse(text ?? "") as Positions;
		if (value && typeof value === "object" && value.positions && typeof value.positions === "object") return value;
	} catch { /* absent or unreadable → empty */ }
	return { positions: {} };
}

/** Layout merge: per node three-way; both moved → the newer file wins. */
export function mergePositions(baseText: string | null, localText: string | null, remoteText: string | null): string {
	const base = parsePositions(baseText).positions, localDoc = parsePositions(localText), remoteDoc = parsePositions(remoteText);
	const local = localDoc.positions, remote = remoteDoc.positions;
	const localNewer = (localDoc.updatedAt ?? "") >= (remoteDoc.updatedAt ?? "");
	const same = (a: unknown, c: unknown) => JSON.stringify(a) === JSON.stringify(c);
	const out: Positions["positions"] = {};
	for (const id of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
		const n = base[id], l = local[id], r = remote[id];
		const pick = same(l, n) ? r : same(r, n) ? l : localNewer ? l : r;
		if (pick) out[id] = pick;
	}
	const updatedAt = [localDoc.updatedAt, remoteDoc.updatedAt].filter((v): v is string => !!v).sort().at(-1);
	return JSON.stringify({ positions: out, ...(updatedAt ? { updatedAt } : {}) }, null, "\t");
}
