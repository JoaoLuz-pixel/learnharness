/**
 * DEVICE SYNC — one sync cycle over abstract sides (owner design 2026-11-15).
 * The caller holds the endpoint's cycle lock; this module never talks SSH or
 * the real filesystem, so it is tested against in-memory sides.
 */
import { decideFile, hashBytes, ledgerLineId, mergeLedger, mergePositions } from "./merge.ts";
import { inSyncScope, type SyncToggles } from "./scope.ts";

export interface ManifestEntry { hash: string; device: string; at: string }
export interface Manifest { version: 1; files: Record<string, ManifestEntry> }
export const emptyManifest = (): Manifest => ({ version: 1, files: {} });

export interface LocalSide {
	/** Every in-scope candidate path → content hash (scope is re-checked here). */
	list(): Promise<Map<string, string>>;
	read(rel: string): Promise<Buffer | null>;
	write(rel: string, bytes: Buffer): Promise<void>;
	remove(rel: string): Promise<void>;
}
export interface RemoteSide {
	read(rel: string): Promise<Buffer | null>;
	write(rel: string, bytes: Buffer): Promise<void>;
	remove(rel: string): Promise<void>;
}
export interface BaseSide {
	hash(rel: string): string | null;
	read(rel: string): Buffer | null;
	set(rel: string, bytes: Buffer | null): void;
	list(): string[];
}

/** A decision the learner owes. `recordId` = the ledger id for graph records. */
export interface SyncConflict {
	id: string;
	rel: string;
	recordId?: string;
	/** Which side no longer has it (delete-vs-edit); absent = both edited. */
	deletedOn?: "local" | "remote";
	remoteDevice?: string;
	remoteAt?: string;
	detectedAt: string;
}
export const conflictId = (rel: string, recordId?: string) => recordId ? `${rel}#${recordId}` : rel;

export interface CycleResult {
	pulled: string[];
	pushed: string[];
	deletedLocal: string[];
	deletedRemote: string[];
	conflicts: SyncConflict[];
	manifestChanged: boolean;
}

export interface CycleInput {
	local: LocalSide;
	remote: RemoteSide;
	base: BaseSide;
	manifest: Manifest;
	toggles: SyncToggles;
	deviceName: string;
	/** Pending conflicts: these files / ledger ids do not sync until resolved. */
	held: readonly SyncConflict[];
	now?: () => string;
}

export class SyncIntegrityError extends Error {}

export async function runSyncCycle(input: CycleInput): Promise<CycleResult> {
	const { local, remote, base, manifest, toggles, deviceName } = input;
	const now = input.now ?? (() => new Date().toISOString());
	const result: CycleResult = { pulled: [], pushed: [], deletedLocal: [], deletedRemote: [], conflicts: [], manifestChanged: false };
	const heldFiles = new Set(input.held.filter(c => !c.recordId).map(c => c.rel));
	const heldIds = (rel: string) => new Set(input.held.filter(c => c.rel === rel && c.recordId).map(c => c.recordId!));
	const localMap = await local.list();
	const rels = new Set([...localMap.keys(), ...Object.keys(manifest.files), ...base.list()]);
	const stamp = (rel: string, bytes: Buffer) => { manifest.files[rel] = { hash: hashBytes(bytes), device: deviceName, at: now() }; result.manifestChanged = true; };
	const pullVerified = async (rel: string): Promise<Buffer> => {
		const bytes = await remote.read(rel);
		if (!bytes || hashBytes(bytes) !== manifest.files[rel]?.hash) throw new SyncIntegrityError(`Remote copy of ${rel} does not match the endpoint manifest`);
		return bytes;
	};

	for (const rel of [...rels].sort()) {
		const scope = inSyncScope(rel, toggles);
		if (!scope || heldFiles.has(rel)) continue;
		const b = base.hash(rel), l = localMap.get(rel) ?? null, r = manifest.files[rel]?.hash ?? null;
		if (b === l && l === r) continue;

		if (scope.kind === "file") {
			const decision = decideFile(b, l, r);
			if (decision === "same") {
				base.set(rel, l === null ? null : await local.read(rel));
			} else if (decision === "pull") {
				const bytes = await pullVerified(rel);
				await local.write(rel, bytes); base.set(rel, bytes); result.pulled.push(rel);
			} else if (decision === "push") {
				const bytes = await local.read(rel);
				if (!bytes) continue; // vanished mid-cycle: next cycle sees the truth
				await remote.write(rel, bytes); stamp(rel, bytes); base.set(rel, bytes); result.pushed.push(rel);
			} else if (decision === "delete-local") {
				await local.remove(rel); base.set(rel, null); result.deletedLocal.push(rel);
			} else if (decision === "delete-remote") {
				await remote.remove(rel); delete manifest.files[rel]; result.manifestChanged = true; base.set(rel, null); result.deletedRemote.push(rel);
			} else {
				const entry = manifest.files[rel];
				result.conflicts.push({ id: conflictId(rel), rel, ...(l === null ? { deletedOn: "local" as const } : r === null ? { deletedOn: "remote" as const } : {}),
					...(entry ? { remoteDevice: entry.device, remoteAt: entry.at } : {}), detectedAt: now() });
			}
			continue;
		}

		const baseText = base.read(rel)?.toString("utf8") ?? null;
		const localText = l === null ? null : (await local.read(rel))?.toString("utf8") ?? null;
		const remoteText = r === null ? null : (await pullVerified(rel)).toString("utf8");
		if (scope.kind === "positions") {
			const merged = Buffer.from(mergePositions(baseText, localText, remoteText));
			if (hashBytes(merged) !== l) { await local.write(rel, merged); result.pulled.push(rel); }
			if (hashBytes(merged) !== r) { await remote.write(rel, merged); stamp(rel, merged); result.pushed.push(rel); }
			base.set(rel, merged);
			continue;
		}
		const merged = mergeLedger(baseText, localText, remoteText, heldIds(rel));
		const localBytes = Buffer.from(merged.local), remoteBytes = Buffer.from(merged.remote);
		if (hashBytes(localBytes) !== l) { await local.write(rel, localBytes); result.pulled.push(rel); }
		if (hashBytes(remoteBytes) !== r) { await remote.write(rel, remoteBytes); stamp(rel, remoteBytes); result.pushed.push(rel); }
		base.set(rel, Buffer.from(merged.base));
		const entry = manifest.files[rel];
		for (const c of merged.conflicts) result.conflicts.push({ id: conflictId(rel, c.id), rel, recordId: c.id, deletedOn: c.deletedOn,
			...(entry ? { remoteDevice: entry.device, remoteAt: entry.at } : {}), detectedAt: now() });
	}
	return result;
}

/** Replace one id's lines in a ledger text with `winner`'s lines for it. */
export function replaceLedgerRecord(text: string | null, id: string, winnerText: string | null): string {
	const own = (text ?? "").split("\n").filter(line => line.trim() && ledgerLineId(line) !== id);
	const won = (winnerText ?? "").split("\n").filter(line => line.trim() && ledgerLineId(line) === id);
	const all = [...own, ...won];
	return all.length ? `${all.join("\n")}\n` : "";
}

export type ConflictChoice = "local" | "remote" | "both";

/**
 * Resolve one conflict (the learner's decision). "local"/"remote" = that
 * side's state wins everywhere (a deletion included); "both" (sessions only)
 * keeps local in place and saves the remote version under `copyRel`.
 */
export async function resolveConflict(conflict: SyncConflict, choice: ConflictChoice, sides: { local: LocalSide; remote: RemoteSide; base: BaseSide; manifest: Manifest; deviceName: string; copyRel?: (bytes: Buffer) => { rel: string; bytes: Buffer }; now?: () => string }): Promise<void> {
	const { local, remote, base, manifest, deviceName } = sides;
	const now = sides.now ?? (() => new Date().toISOString());
	const rel = conflict.rel;
	const stamp = (bytes: Buffer) => { manifest.files[rel] = { hash: hashBytes(bytes), device: deviceName, at: now() }; };
	const localBytes = await local.read(rel);
	const remoteBytes = manifest.files[rel] ? await remote.read(rel) : null;
	if (conflict.recordId) {
		const winner = (choice === "remote" ? remoteBytes : localBytes)?.toString("utf8") ?? null;
		const nextLocal = Buffer.from(replaceLedgerRecord(localBytes?.toString("utf8") ?? null, conflict.recordId, winner));
		const nextRemote = Buffer.from(replaceLedgerRecord(remoteBytes?.toString("utf8") ?? null, conflict.recordId, winner));
		await local.write(rel, nextLocal);
		await remote.write(rel, nextRemote); stamp(nextRemote);
		base.set(rel, Buffer.from(replaceLedgerRecord(base.read(rel)?.toString("utf8") ?? null, conflict.recordId, winner)));
		return;
	}
	if (choice === "both") {
		if (!remoteBytes || !localBytes || !sides.copyRel) throw new Error("Keeping both needs two versions of a session");
		const copy = sides.copyRel(remoteBytes);
		await local.write(copy.rel, copy.bytes); // the next cycle pushes the new session
	}
	const winner = choice === "remote" ? remoteBytes : localBytes;
	if (winner) {
		await local.write(rel, winner);
		await remote.write(rel, winner); stamp(winner);
	} else {
		await local.remove(rel);
		await remote.remove(rel); delete manifest.files[rel];
	}
	base.set(rel, winner);
}
