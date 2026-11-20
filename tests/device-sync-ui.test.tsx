/**
 * Device Sync's setup commands and UI pins (owner design 2026-11-15).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceSyncStatus } from "../src/core/device-sync.ts";
import { endpointCommands, publicKeyBlob } from "../src/core/endpoint-commands.ts";
import { generateDeviceKey, hostKeyFingerprint } from "../src/sync/sftp.ts";
import { SyncIndicatorView } from "../components/sync-indicator.tsx";
import { SyncDeleteNotice } from "../components/sync-delete-notice.tsx";
import { DeleteSessionBody } from "../components/delete-session-dialog.tsx";
import { EndpointInstructions } from "../components/settings/device-sync-section.tsx";

const key = generateDeviceKey("learnharness-Test-PC").publicKey;

describe("endpoint commands", () => {
	it("every OS creates the hardened SFTP-only user and embeds only this device's key", () => {
		for (const os of ["linux", "macos", "windows"] as const) {
			const c = endpointCommands(os, key);
			const all = [...c.setup.map(s => s.code), c.addDevice.code, c.removeDevice.code].join("\n");
			for (const hardening of ["ForceCommand internal-sftp", "ChrootDirectory", "PasswordAuthentication no", "AllowTcpForwarding no", "PermitTTY no", "X11Forwarding no"]) assert.ok(all.includes(hardening), `${os}: ${hardening}`);
			assert.ok(c.addDevice.code.includes(`restrict ${key.split(" ").slice(0, 2).join(" ")}`), `${os}: restricted key line`);
			assert.ok(c.removeDevice.code.includes(publicKeyBlob(key)), `${os}: revoke targets this key`);
			assert.doesNotMatch(all, /PRIVATE KEY/, `${os}: never a private key`);
		}
		assert.match(endpointCommands("linux", key).setup[1]!.code, /--shell \/usr\/sbin\/nologin/);
		assert.match(endpointCommands("macos", key).setup[1]!.code, /UserShell \/usr\/bin\/false/);
		assert.match(endpointCommands("windows", key).setup[1]!.code, /New-LocalUser -Name learnharness/);
	});
	it("refuses anything but an ed25519 public key, and strips unsafe comment characters", () => {
		assert.throws(() => endpointCommands("linux", "ssh-rsa AAAA test"), /ed25519/);
		assert.throws(() => endpointCommands("linux", "ssh-ed25519 AAAA'; rm -rf / #"), /ed25519/);
		const hostile = `${key.split(" ").slice(0, 2).join(" ")} me'$(reboot)`;
		const line = endpointCommands("linux", hostile).addDevice.code;
		assert.doesNotMatch(line, /\$\(|'\$/, "no shell metacharacters from the comment");
	});
	it("fingerprints match OpenSSH's SHA256 format", () => {
		assert.match(hostKeyFingerprint(Buffer.from("host key bytes")), /^SHA256:[A-Za-z0-9+/]{43}$/);
	});
});

const status = (patch: Partial<DeviceSyncStatus>): DeviceSyncStatus => ({
	phase: "in-sync", deviceId: "dev_a", deviceName: "Laptop", publicKey: key, endpoint: { host: "nas", port: 22, fingerprint: "SHA256:x" }, sync: { id: "main", name: "Shared progress" }, enabled: true,
	toggles: { layout: true, settings: true, plugins: true, promptsThemes: true }, intervalSec: 10, lastSyncAt: null, lastError: null,
	conflicts: [], devices: [], locks: [], setAside: [], ...patch,
});

describe("Device Sync UI", () => {
	it("the sidebar indicator hides until an endpoint exists, and badges conflicts", () => {
		assert.equal(renderToStaticMarkup(<SyncIndicatorView status={status({ endpoint: null })} onOpen={() => {}} />), "");
		assert.match(renderToStaticMarkup(<SyncIndicatorView status={status({})} onOpen={() => {}} />), /data-phase="in-sync"/);
		const conflict = { id: "c", label: "Session “x”", kind: "session" as const, detectedAt: "t", canKeepBoth: true };
		const html = renderToStaticMarkup(<SyncIndicatorView status={status({ conflicts: [conflict, { ...conflict, id: "d" }] })} onOpen={() => {}} />);
		assert.match(html, /data-testid="sync-conflict-badge"[^>]*>2</);
		assert.match(html, /2 sync conflicts to resolve/);
	});
	it("a delete while sync is on needs the extra everywhere-approval", () => {
		const body = (approved: boolean | null) => renderToStaticMarkup(<DeleteSessionBody chat={{ id: "c", title: "T" }} traces={false} busy={false} failure={null}
			onTraces={() => {}} onClose={() => {}} onRun={() => {}} {...(approved === null ? {} : { syncGate: { approved, onApproved: () => {} } })} />);
		assert.doesNotMatch(body(null), /sync-delete-notice/, "sync off: unchanged dialog");
		assert.match(body(false), /data-testid="delete-confirm"[^>]*disabled=""/, "not approved yet: Delete disabled");
		assert.doesNotMatch(body(true), /data-testid="delete-confirm"[^>]*disabled=""/);
		assert.match(renderToStaticMarkup(<SyncDeleteNotice gate={{ approved: false, onApproved: () => {} }} what="this session" />), /Also delete this session on all my synced devices/);
	});
	it("setup instructions show Linux first with copyable steps", () => {
		const html = renderToStaticMarkup(<EndpointInstructions publicKey={key} />);
		assert.match(html, /aria-selected="true"[^>]*>Linux</);
		assert.match(html, /aria-selected="true" class="[^"]*bg-primary[^"]*text-primary-foreground/, "selected tab: primary fill");
		assert.match(html, /aria-selected="false" class="[^"]*bg-background/, "other tabs: outlined");
		assert.ok((html.match(/data-testid="sync-command"/g) ?? []).length >= 3);
		assert.match(html, /Copy: Allow this device/);
	});
});
