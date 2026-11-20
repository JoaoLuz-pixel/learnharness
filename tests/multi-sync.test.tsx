/**
 * Several syncs per endpoint (owner, 2026-11-20): the first sync stays in
 * /sync (older versions keep syncing it), others live in /sync/syncs/<id>;
 * a connecting device sees every sync with its paired devices and joins one
 * or creates its own; Change sync moves a device without forgetting the
 * endpoint; the app never deletes a sync (a copyable command does).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-multisync-"));
process.env.LH_SYNC_DIR = syncDir;
// A device set up before several syncs existed: endpoint configured, no syncId.
fs.writeFileSync(path.join(syncDir, "state.json"), JSON.stringify({
	version: 1, deviceId: "dev_old", deviceName: "Desktop", endpoint: { host: "nas", port: 22, fingerprint: "SHA256:x" },
	enabled: false, joined: true, conflicts: [], setAside: [], lastSyncAt: null,
}));

const { cleanSyncName, isSyncId, MAIN_SYNC_DEFAULT_NAME, newSyncId, syncRoot } = await import("../src/sync/sftp.ts");
const { removeSyncCommand } = await import("../src/core/endpoint-commands.ts");
const { initialPick, pickTarget, SyncChooser } = await import("../components/settings/device-sync-section.tsx");
const { deviceSync } = await import("../src/server/device-sync.ts");

const sync = (id: string, name: string, devices: string[] = []) => ({ id, name, createdAt: "2026-11-20T10:00:00.000Z", createdBy: "Desktop",
	devices: devices.map((d, i) => ({ id: `dev_${i}`, name: d, lastSeen: "2026-11-20T11:00:00.000Z" })) });

describe("endpoint layout", () => {
	it("the first sync stays in /sync; others get their own folder; ids are strict", () => {
		assert.equal(syncRoot("main"), "/sync");
		const id = newSyncId();
		assert.ok(isSyncId(id));
		assert.equal(syncRoot(id), `/sync/syncs/${id}`);
		for (const bad of ["", "../x", "s_", "s_ABCDEFGH", "s_abc/def12", "main/..", "syncs"]) {
			assert.equal(isSyncId(bad), false, bad);
			assert.throws(() => syncRoot(bad));
		}
	});
	it("names are trimmed single-line text of at most 60 characters, never empty", () => {
		assert.equal(cleanSyncName("  Uni\n  work\t"), "Uni work");
		assert.equal(cleanSyncName("x".repeat(80)).length, 60);
		assert.throws(() => cleanSyncName("   "), /name/);
		assert.throws(() => cleanSyncName(42));
	});
});

describe("removing a sync is by hand on the endpoint", () => {
	it("targets exactly one sync's files on every OS", () => {
		const id = "s_0123456789abcdef";
		assert.equal(removeSyncCommand("linux", id).code, `sudo rm -rf /srv/learnharness/sync/syncs/${id}`);
		assert.equal(removeSyncCommand("macos", id).code, `sudo rm -rf /var/learnharness/sync/syncs/${id}`);
		assert.match(removeSyncCommand("windows", id).code, /^Remove-Item -Recurse -Force .*'C:\\LearnHarnessSync\\sync\\syncs\\s_0123456789abcdef'$/);
		const main = removeSyncCommand("linux", "main").code;
		assert.match(main, /\/srv\/learnharness\/sync\/manifest\.json/);
		assert.doesNotMatch(main, /\/sync\/syncs|\/sync( |$)/, "removing the first sync never touches the others");
		assert.throws(() => removeSyncCommand("linux", "../../etc"));
	});
});

describe("devices from before several syncs", () => {
	it("are in the first sync, named “Shared progress”, with nothing to do", () => {
		const status = deviceSync().status();
		assert.deepEqual(status.sync, { id: "main", name: MAIN_SYNC_DEFAULT_NAME });
		assert.equal(MAIN_SYNC_DEFAULT_NAME, "Shared progress");
	});
});

describe("the sync chooser", () => {
	it("an empty endpoint offers only creating the first sync, prefilled with the device's name", () => {
		const pick = initialPick([], "Laptop");
		assert.deepEqual(pickTarget(pick), { kind: "create", name: "Laptop's sync" });
		const html = renderToStaticMarkup(<SyncChooser syncs={[]} pick={pick} onPick={() => {}} />);
		assert.match(html, /no syncs yet/);
		assert.doesNotMatch(html, /data-testid="sync-option"/);
	});
	it("lists every sync with its paired devices, and asks merge or set aside when joining", () => {
		const syncs = [sync("main", "Shared progress", ["Desktop", "Laptop"]), sync("s_0123456789abcdef", "Uni", [])];
		const pick = { ...initialPick(syncs, "Tablet"), joinId: "main" };
		const html = renderToStaticMarkup(<SyncChooser syncs={syncs} pick={pick} onPick={() => {}} />);
		assert.equal(html.match(/data-testid="sync-option"/g)?.length, 2);
		assert.match(html, /Shared progress/);
		assert.match(html, /Devices: Desktop \(last seen [^)]+\), Laptop/);
		assert.match(html, /No devices yet/);
		assert.match(html, /Create my own sync/);
		assert.match(html, /Merge it/);
		assert.match(html, /Set it aside/);
		assert.match(html, /Remove this sync from the endpoint/);
		assert.deepEqual(pickTarget(pick), { kind: "join", id: "main" });
	});
	it("Change sync: the current sync is shown but cannot be picked", () => {
		const syncs = [sync("main", "Shared progress", ["Desktop"]), sync("s_0123456789abcdef", "Uni", ["Laptop"])];
		const pick = initialPick(syncs, "Desktop", "main");
		assert.deepEqual(pickTarget(pick), { kind: "join", id: "s_0123456789abcdef" }, "the only other sync is preselected");
		const html = renderToStaticMarkup(<SyncChooser syncs={syncs} pick={pick} onPick={() => {}} currentSyncId="main" />);
		assert.match(html, /Shared progress \(this device(&#x27;|')s sync\)/);
		assert.match(html, /<input type="radio" disabled="" name="sync-pick"\/>/);
	});
	it("an incomplete pick sends nothing", () => {
		assert.equal(pickTarget({ mode: "join", joinId: null, name: "", join: "merge" }), null, "two syncs, none picked yet");
		assert.equal(pickTarget({ mode: "create", joinId: null, name: "  ", join: "merge" }), null, "no name");
	});
});
