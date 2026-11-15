/**
 * Device Sync's pure merge (owner design 2026-11-15): who changed what is
 * read from each device's own base, so nothing is silently lost.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideFile, mergeLedger, mergePositions } from "../src/sync/merge.ts";
import { classifySyncPath, DEFAULT_SYNC_TOGGLES, inSyncScope } from "../src/sync/scope.ts";

describe("decideFile", () => {
	it("one side changed → that side wins", () => {
		assert.equal(decideFile("a", "a", "b"), "pull");
		assert.equal(decideFile("a", "b", "a"), "push");
		assert.equal(decideFile(null, "new", null), "push", "created here");
		assert.equal(decideFile(null, null, "new"), "pull", "created elsewhere");
	});
	it("deletions propagate only when the other side is untouched", () => {
		assert.equal(decideFile("a", "a", null), "delete-local", "deleted elsewhere — a long-offline device does not resurrect it");
		assert.equal(decideFile("a", null, "a"), "delete-remote");
		assert.equal(decideFile("a", "edited", null), "conflict", "deleted elsewhere but edited here → ask");
		assert.equal(decideFile("a", null, "edited"), "conflict");
	});
	it("both changed differently → conflict; identical → same", () => {
		assert.equal(decideFile("a", "b", "c"), "conflict");
		assert.equal(decideFile(null, "b", "c"), "conflict", "first join: both sides have different versions");
		assert.equal(decideFile("a", "b", "b"), "same");
		assert.equal(decideFile("a", null, null), "same");
	});
});

const node = (id: string, phrase: string, at = "2026-11-15T10:00:00Z") => JSON.stringify({ id, name: phrase, statement: phrase, aliases: [], createdAt: at, provenance: [] });

describe("mergeLedger", () => {
	it("two devices adding knowledge never conflict — both lines land on both sides", () => {
		const base = `${node("n1", "a")}\n`;
		const local = `${base}${node("n2", "local")}\n`;
		const remote = `${base}${node("n3", "remote")}\n`;
		const merged = mergeLedger(base, local, remote);
		assert.deepEqual(merged.conflicts, []);
		assert.equal(merged.local, merged.remote);
		assert.equal(merged.local, `${node("n1", "a")}\n${node("n2", "local")}\n${node("n3", "remote")}\n`);
		assert.equal(merged.base, merged.local);
	});
	it("a line removed on one side is removed everywhere", () => {
		const base = `${node("n1", "a")}\n${node("n2", "b")}\n`;
		const local = `${node("n1", "a")}\n`;
		const merged = mergeLedger(base, local, base);
		assert.equal(merged.remote, local);
	});
	it("an id deleted on one side but added to on the other is held as a conflict", () => {
		const base = `${node("n1", "a")}\n${node("n2", "b")}\n`;
		const local = `${node("n1", "a")}\n`; // n2 deleted here
		const remote = `${base}${node("n2", "new phrasing")}\n`; // n2 extended there
		const merged = mergeLedger(base, local, remote);
		assert.deepEqual(merged.conflicts, [{ id: "n2", deletedOn: "local" }]);
		assert.ok(!merged.local.includes("n2"), "local keeps its deletion while undecided");
		assert.ok(merged.remote.includes("new phrasing"), "remote keeps its addition while undecided");
		// Next cycle with the id held: same disagreement, no new conflict, nothing lost.
		const again = mergeLedger(merged.base, merged.local, merged.remote, new Set(["n2"]));
		assert.deepEqual(again.conflicts, []);
		assert.equal(again.local, merged.local);
		assert.equal(again.remote, merged.remote);
	});
	it("first join (no base) unions both histories", () => {
		const merged = mergeLedger(null, `${node("n1", "a")}\n`, `${node("n9", "z")}\n`);
		assert.equal(merged.local.split("\n").filter(Boolean).length, 2);
		assert.equal(merged.local, merged.remote);
	});
});

describe("mergePositions", () => {
	const doc = (positions: Record<string, { x: number; y: number }>, updatedAt: string) => JSON.stringify({ positions, updatedAt });
	it("per node: whoever moved it wins; both moved → the newer file wins", () => {
		const base = doc({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, "1");
		const local = doc({ a: { x: 1, y: 1 }, b: { x: 5, y: 5 } }, "3");
		const remote = doc({ a: { x: 0, y: 0 }, b: { x: 9, y: 9 } }, "2");
		const merged = JSON.parse(mergePositions(base, local, remote)) as { positions: Record<string, { x: number }>; updatedAt: string };
		assert.equal(merged.positions.a!.x, 1, "only local moved a");
		assert.equal(merged.positions.b!.x, 5, "both moved b; local is newer");
		assert.equal(merged.updatedAt, "3");
	});
});

describe("sync scope", () => {
	it("syncs progress always and the rest per toggle; never temps, traversal or unknowns", () => {
		assert.equal(classifySyncPath("chats/chat_a.json")?.category, "progress");
		assert.equal(classifySyncPath("graph/nodes.jsonl")?.kind, "ledger");
		assert.equal(classifySyncPath("graph/positions.json")?.kind, "positions");
		assert.equal(classifySyncPath("settings.json")?.category, "settings");
		assert.equal(classifySyncPath("themes/dark.json")?.category, "promptsThemes");
		for (const bad of ["../auth.json", "auth.json", "chats/.chat.json", "chats/chat_a.json.tmp-123", "debug/x.jsonl", "chats/sub/x.json"]) assert.equal(classifySyncPath(bad), null, bad);
		assert.equal(inSyncScope("settings.json", { ...DEFAULT_SYNC_TOGGLES, settings: false }), null);
		assert.ok(inSyncScope("chats/chat_a.json", { layout: false, settings: false, plugins: false, promptsThemes: false }));
	});
});
