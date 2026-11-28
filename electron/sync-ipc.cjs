"use strict";
/**
 * DEVICE SYNC — the shell's part (owner, 2026-11-28), over the server
 * child's own IPC channel (no socket, no token service):
 *  - "seal"/"open": remembered sync keys are encrypted with the system's
 *    secure storage (Electron safeStorage: DPAPI, Keychain, the keyring).
 *    When the system offers none, "seal" answers without `sealed` and the
 *    server keeps the key in its own user-only file.
 *  - "hosting": whether the built-in host runs (the tray keeps it alive).
 */
const { safeStorage } = require("electron");

function attachSyncChild(child, { onHosting }) {
	const send = (value) => { if (child.connected) child.send({ channel: "lh:sync", ...value }, () => {}); };
	const listener = (message) => {
		if (!message || message.channel !== "lh:sync") return;
		if (message.op === "hosting") { onHosting(message.hosting === true); return; }
		if (typeof message.id !== "string" || message.id.length > 100) return;
		try {
			if (message.op === "seal" && typeof message.value === "string" && message.value.length <= 100) {
				if (!safeStorage.isEncryptionAvailable()) return send({ id: message.id, op: message.op, ok: true });
				// Linux without a keyring falls back to a fixed key: no better than the file.
				if (process.platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function" && safeStorage.getSelectedStorageBackend() === "basic_text") return send({ id: message.id, op: message.op, ok: true });
				return send({ id: message.id, op: message.op, ok: true, sealed: safeStorage.encryptString(message.value).toString("base64") });
			}
			if (message.op === "open" && typeof message.sealed === "string" && message.sealed.length <= 4096) {
				return send({ id: message.id, op: message.op, ok: true, value: safeStorage.decryptString(Buffer.from(message.sealed, "base64")) });
			}
			send({ id: message.id, op: message.op, ok: false, error: "Invalid sync operation" });
		} catch { send({ id: message.id, op: message.op, ok: false, error: "The system's secure storage could not be used." }); }
	};
	child.on("message", listener);
	return { dispose: () => child.removeListener("message", listener) };
}

module.exports = { attachSyncChild };
