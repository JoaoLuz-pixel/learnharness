/**
 * Device Sync settings for cloud folders, the built-in host and sync
 * passwords (owner, 2026-11-28): what the chooser shows and sends.
 */
import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SyncChoiceView } from "../src/core/device-sync.ts";
import { endpointLabel, initialPick, pickTarget, rulesFor, SyncChooser, type ChooserRules } from "../components/settings/device-sync-section.tsx";

const locked: SyncChoiceView = { id: "p_0123456789abcdef", name: "Uni", locked: true };
const open: SyncChoiceView = { id: "p_fedcba9876543210", name: "Hobby", locked: false, createdAt: "2026-11-28T10:00:00.000Z", createdBy: "Laptop", devices: [{ id: "dev_a", name: "Laptop", lastSeen: "2026-11-28T11:00:00.000Z" }] };
const folderRules: ChooserRules = { kind: "folder", canCreate: true, passwordRequired: false };
const hostRules: ChooserRules = { kind: "host", canCreate: false, passwordRequired: true };
const selfRules: ChooserRules = { kind: "self", canCreate: true, passwordRequired: true };

describe("protected syncs in the chooser", () => {
	it("show their name and a lock only, and ask for the password to join", () => {
		const pick = { ...initialPick([locked, open], "Tablet", null, folderRules), joinId: locked.id };
		const html = renderToStaticMarkup(<SyncChooser syncs={[locked, open]} pick={pick} onPick={() => {}} rules={folderRules} />);
		assert.match(html, /aria-label="Password protected"/);
		assert.match(html, /Its devices and progress show once you join/);
		assert.match(html, /Created by Laptop/, "the open sync still shows its details");
		assert.match(html, /data-testid="sync-join-password"/);
		assert.equal(pickTarget(pick, [locked, open], folderRules), null, "no password yet: nothing to send");
		assert.deepEqual(pickTarget({ ...pick, password: "hunter22" }, [locked, open], folderRules), { kind: "join", id: locked.id, password: "hunter22" });
		assert.deepEqual(pickTarget({ ...pick, joinId: open.id }, [locked, open], folderRules), { kind: "join", id: open.id }, "an open sync needs none");
	});

	it("a new sync's password is optional on folders and SSH, typed twice, at least 8 characters", () => {
		const pick = initialPick([], "Laptop", null, folderRules);
		assert.deepEqual(pickTarget(pick, [], folderRules), { kind: "create", name: "Laptop's sync" }, "without protection, as before");
		const protect = { ...pick, protect: true, password: "short", confirm: "short" };
		assert.equal(pickTarget(protect, [], folderRules), null);
		assert.equal(pickTarget({ ...protect, password: "long enough", confirm: "long enougH" }, [], folderRules), null, "the two differ");
		assert.deepEqual(pickTarget({ ...protect, password: "long enough", confirm: "long enough" }, [], folderRules), { kind: "create", name: "Laptop's sync", password: "long enough" });
		const html = renderToStaticMarkup(<SyncChooser syncs={[]} pick={protect} onPick={() => {}} rules={folderRules} />);
		assert.match(html, /can&#x27;t be changed later/);
		assert.match(html, /could still delete its files there/, "the limit on folders is said");
	});

	it("on this device's host a password is required; on another device's host nothing can be created", () => {
		const self = initialPick([], "Desk", null, selfRules);
		assert.equal(self.protect, true);
		assert.equal(pickTarget(self, [], selfRules), null, "no password: nothing to send");
		const selfHtml = renderToStaticMarkup(<SyncChooser syncs={[]} pick={self} onPick={() => {}} rules={selfRules} />);
		assert.doesNotMatch(selfHtml, /data-testid="sync-protect"/, "no opt-out checkbox");
		assert.doesNotMatch(selfHtml, /could still delete/, "the host enforces access itself");
		const remote = initialPick([locked], "Tablet", null, hostRules);
		assert.equal(remote.mode, "join");
		const html = renderToStaticMarkup(<SyncChooser syncs={[locked]} pick={remote} onPick={() => {}} rules={hostRules} />);
		assert.doesNotMatch(html, /sync-option-create/);
		assert.equal(pickTarget({ ...remote, mode: "create" }, [locked], hostRules), null);
	});
});

describe("connected endpoints", () => {
	it("are labelled by kind, and the chooser rules follow the kind", () => {
		assert.equal(endpointLabel({ kind: "folder", path: "C:\\Users\\me\\OneDrive" }).label, "Cloud folder");
		assert.equal(endpointLabel({ kind: "self" }).label, "This device's host");
		assert.match(endpointLabel({ kind: "host", host: "100.64.0.2", port: 7419, fingerprint: "SHA256:x" }).hint, /Another device's host/);
		assert.match(endpointLabel({ kind: "ssh", host: "nas", port: 22, fingerprint: "SHA256:x" }).hint, /SSH endpoint/);
		assert.deepEqual(rulesFor({ kind: "host", host: "h", port: 1, fingerprint: "f" }), hostRules);
		assert.equal(rulesFor({ kind: "folder", path: "x" }).passwordRequired, false);
		assert.equal(rulesFor({ kind: "self" }).passwordRequired, true);
	});
});
