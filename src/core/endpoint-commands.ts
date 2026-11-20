/**
 * DEVICE SYNC — the copyable endpoint setup (owner, 2026-11-15). The safest
 * shape on every OS: a dedicated `learnharness` user that can ONLY use SFTP,
 * chrooted to its own folder, key-only logins, no shell / TTY / forwarding.
 * The writable folder is always /sync inside the chroot.
 */
export type EndpointOs = "linux" | "macos" | "windows";
export interface CommandStep { title: string; note?: string; code: string }
export interface EndpointCommands { setup: CommandStep[]; addDevice: CommandStep; removeDevice: CommandStep }

/** The key's base64 blob: unique per device, safe inside sed `#` / regex. */
export function publicKeyBlob(publicKey: string): string {
	const blob = publicKey.trim().split(/\s+/)[1] ?? "";
	if (!/^[A-Za-z0-9+/=]+$/.test(blob)) throw new Error("Not an OpenSSH public key");
	return blob;
}
/** Only ssh-ed25519 lines with a safe comment are ever embedded in commands. */
function authorizedLine(publicKey: string): string {
	const [type, blob, ...rest] = publicKey.trim().split(/\s+/);
	if (type !== "ssh-ed25519" || !blob || !/^[A-Za-z0-9+/=]+$/.test(blob)) throw new Error("Not an ed25519 public key");
	const comment = rest.join(" ").replace(/[^A-Za-z0-9 ._@-]/g, "").slice(0, 60);
	return `restrict ${type} ${blob}${comment ? ` ${comment}` : ""}`;
}

const MATCH_BLOCK = (chroot: string, keys: string) => `Match User learnharness
    ChrootDirectory ${chroot}
    ForceCommand internal-sftp
    AuthorizedKeysFile ${keys}
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no`;

export function endpointCommands(os: EndpointOs, publicKey: string): EndpointCommands {
	const line = authorizedLine(publicKey);
	const blob = publicKeyBlob(publicKey);
	if (os === "windows") {
		const keys = "C:\\ProgramData\\ssh\\learnharness\\authorized_keys";
		return {
			setup: [
				{ title: "Install and start the OpenSSH Server", note: "Run PowerShell as Administrator on the endpoint.", code: [
					"Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0",
					"Set-Service sshd -StartupType Automatic",
					"Start-Service sshd",
				].join("\n") },
				{ title: "Create the SFTP-only sync user and its locked folder", note: "The random password is never shown or used: logins are key-only.", code: [
					"$pw = ConvertTo-SecureString ([Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))) -AsPlainText -Force",
					"New-LocalUser -Name learnharness -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'LearnHarness Device Sync'",
					"New-Item -ItemType Directory -Force C:\\LearnHarnessSync\\sync | Out-Null",
					"icacls C:\\LearnHarnessSync /inheritance:r /grant 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' 'learnharness:(RX)'",
					"icacls C:\\LearnHarnessSync\\sync /grant 'learnharness:(OI)(CI)M'",
					"New-Item -ItemType Directory -Force C:\\ProgramData\\ssh\\learnharness | Out-Null",
					`New-Item -ItemType File -Force ${keys} | Out-Null`,
					`icacls ${keys} /inheritance:r /grant 'Administrators:F' 'SYSTEM:F' 'learnharness:R'`,
					`Add-Content -Path C:\\ProgramData\\ssh\\sshd_config -Value @"\n\n${MATCH_BLOCK("C:\\LearnHarnessSync", "__PROGRAMDATA__/ssh/learnharness/authorized_keys")}\n"@`,
					"Restart-Service sshd",
				].join("\n") },
			],
			addDevice: { title: "Allow this device", note: "Run once per device (as Administrator).", code: `Add-Content -Path ${keys} -Value '${line}'` },
			removeDevice: { title: "Revoke this device", note: "Run on the endpoint (as Administrator) to cut this device off for good.", code:
				`(Get-Content ${keys}) | Where-Object { $_ -notmatch [regex]::Escape('${blob}') } | Set-Content ${keys}` },
		};
	}
	const mac = os === "macos";
	const home = mac ? "/var/learnharness" : "/srv/learnharness";
	const keys = "/etc/ssh/learnharness/authorized_keys";
	const createUser = mac ? [
		"sudo dscl . -create /Users/learnharness",
		"sudo dscl . -create /Users/learnharness UserShell /usr/bin/false",
		"sudo dscl . -create /Users/learnharness RealName 'LearnHarness Device Sync'",
		"sudo dscl . -create /Users/learnharness UniqueID 450",
		"sudo dscl . -create /Users/learnharness PrimaryGroupID 20",
		`sudo dscl . -create /Users/learnharness NFSHomeDirectory ${home}`,
		"sudo dscl . -create /Users/learnharness IsHidden 1",
		`sudo mkdir -p ${home}/sync`,
		`sudo chown root:wheel ${home} && sudo chmod 755 ${home}`,
		`sudo chown learnharness:staff ${home}/sync && sudo chmod 700 ${home}/sync`,
		"sudo dseditgroup -o edit -a learnharness -t user com.apple.access_ssh 2>/dev/null || true",
	] : [
		`sudo useradd --system --create-home --home-dir ${home} --shell /usr/sbin/nologin learnharness`,
		"sudo usermod -p '*' learnharness",
		`sudo chown root:root ${home} && sudo chmod 755 ${home}`,
		`sudo mkdir -p ${home}/sync`,
		`sudo chown learnharness:learnharness ${home}/sync && sudo chmod 700 ${home}/sync`,
	];
	const reload = mac ? "sudo /usr/sbin/sshd -t && sudo launchctl kickstart -k system/com.openssh.sshd" : "sudo sshd -t && (sudo systemctl try-reload-or-restart ssh 2>/dev/null || sudo systemctl try-reload-or-restart sshd)";
	return {
		setup: [
			mac
				? { title: "Turn on Remote Login (SSH)", note: "Run in Terminal on the Mac endpoint, as an administrator.", code: "sudo systemsetup -setremotelogin on" }
				: { title: "Install the SSH server", note: "Debian/Ubuntu shown; use your distribution's package manager otherwise.", code: "sudo apt-get update && sudo apt-get install -y openssh-server" },
			{ title: "Create the SFTP-only sync user and its locked folder", note: "No password and no shell: it can only exchange files inside its own folder.", code: [
				...createUser,
				"sudo mkdir -p /etc/ssh/learnharness /etc/ssh/sshd_config.d",
				`sudo touch ${keys} && sudo chmod 644 ${keys}`,
				`sudo tee /etc/ssh/sshd_config.d/learnharness.conf >/dev/null <<'EOF'\n${MATCH_BLOCK(home, keys)}\nEOF`,
				// No Include line: append the Match block itself at the END (its standard place).
				`grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || sudo tee -a /etc/ssh/sshd_config < /etc/ssh/sshd_config.d/learnharness.conf >/dev/null`,
				reload,
			].join("\n") },
		],
		addDevice: { title: "Allow this device", note: "Run once per device on the endpoint.", code: `echo '${line}' | sudo tee -a ${keys} >/dev/null` },
		removeDevice: { title: "Revoke this device", note: "Run on the endpoint to cut this device off for good.", code: `sudo sed -i${mac ? " ''" : ""} '\\#${blob}#d' ${keys}` },
	};
}

/** The folders and files the first sync ("main") keeps directly in /sync. */
const MAIN_SYNC_ENTRIES = ["meta.json", "manifest.json", "data", "devices", "locks", ".cycle-lock"];

/**
 * Remove a sync nobody uses any more, by hand on the endpoint (owner,
 * 2026-11-20: the app never deletes a sync). Its devices' own progress is
 * untouched; they simply have no sync until they pick another.
 */
export function removeSyncCommand(os: EndpointOs, syncId: string): CommandStep {
	if (syncId !== "main" && !/^s_[a-z0-9]{8,32}$/.test(syncId)) throw new Error("Unknown sync id");
	const note = "Run on the endpoint as an administrator, and only once every device has left this sync (Change sync or Forget). A device still in it stops syncing and asks for another sync; one on an older app version, from before several syncs, could lose its local copy.";
	if (os === "windows") {
		const base = "C:\\LearnHarnessSync\\sync";
		const targets = syncId === "main" ? MAIN_SYNC_ENTRIES.map(e => `${base}\\${e}`) : [`${base}\\syncs\\${syncId}`];
		return { title: "Remove this sync from the endpoint", note, code: `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${targets.map(t => `'${t}'`).join(", ")}` };
	}
	const base = `${os === "macos" ? "/var/learnharness" : "/srv/learnharness"}/sync`;
	const targets = syncId === "main" ? MAIN_SYNC_ENTRIES.map(e => `${base}/${e}`) : [`${base}/syncs/${syncId}`];
	return { title: "Remove this sync from the endpoint", note, code: `sudo rm -rf ${targets.join(" ")}` };
}
