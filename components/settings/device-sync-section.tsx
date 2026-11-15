"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { SYNC_INTERVALS, endpointCommands, type ConflictDecision, type DeviceSyncStatus, type EndpointOs, type JoinChoice, type SyncConflictView, type SyncProbeResult } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";
import { useDeviceSync } from "@/components/use-device-sync";
import { HostDialog } from "@/components/host-dialog";

/**
 * DEVICE SYNC (owner design, 2026-11-15): one SSH endpoint keeps every
 * device's progress merged. Everything a person needs is on this page: the
 * device key, copyable endpoint commands per OS, connect / disconnect /
 * forget, what to sync, conflicts to resolve, set-aside progress.
 */
export const PHASE_LABEL: Record<DeviceSyncStatus["phase"], string> = {
	off: "Off", connecting: "Connecting…", syncing: "Syncing…", "in-sync": "In sync", offline: "Offline — working locally, retrying", blocked: "Blocked — the endpoint's identity changed",
};
const TOGGLE_LABELS = [
	["layout", "Graph layout", "Node positions on the graph map"],
	["settings", "Settings", "General, appearance, models and graph settings"],
	["plugins", "Plugins & their data", "Which plugins are on, and what they store"],
	["promptsThemes", "Prompt overrides & themes", "Your custom teacher prompts and themes"],
] as const;

const button = "rounded-sm border border-border bg-background px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "rounded-sm border border-primary bg-primary px-2.5 py-1 font-ui text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const danger = "rounded-sm border border-destructive/50 bg-destructive/10 px-2.5 py-1 font-ui text-xs text-destructive transition-colors hover:bg-destructive/20";
const input = "h-7 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none focus:border-primary/60";

function when(iso: string | null | undefined): string {
	if (!iso) return "never";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function CopyBlock({ code, label }: { code: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return <div className="relative">
		<pre data-testid="sync-command" className="max-h-64 overflow-auto whitespace-pre rounded-md border bg-muted/40 p-2 pr-16 font-mono text-[11px] leading-relaxed text-foreground">{code}</pre>
		<button type="button" aria-label={`Copy: ${label}`} className={`${button} absolute right-1.5 top-1.5 flex items-center gap-1 bg-card`}
			onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
			{copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}{copied ? "Copied" : "Copy"}
		</button>
	</div>;
}

export function EndpointInstructions({ publicKey }: { publicKey: string }) {
	const [os, setOs] = useState<EndpointOs>("linux");
	const commands = endpointCommands(os, publicKey);
	return <div data-testid="sync-instructions" className="flex flex-col gap-3">
		<div role="tablist" aria-label="Endpoint operating system" className="flex gap-1">
			{(["linux", "macos", "windows"] as const).map(id => (
				<button key={id} type="button" role="tab" aria-selected={os === id} onClick={() => setOs(id)}
					className={os === id ? primary : button}>{id === "linux" ? "Linux" : id === "macos" ? "macOS" : "Windows"}</button>
			))}
		</div>
		{[...commands.setup, commands.addDevice].map((step, index) => (
			<div key={step.title} className="flex flex-col gap-1">
				<p className="font-ui text-xs text-foreground">{index + 1}. {step.title}</p>
				{step.note && <p className="text-xs text-muted-foreground">{step.note}</p>}
				<CopyBlock code={step.code} label={step.title} />
			</div>
		))}
		<p className="text-xs text-muted-foreground">Then come back here and enter the endpoint&apos;s address below. For each extra device, only step {commands.setup.length + 1} is needed, with that device&apos;s own key.</p>
	</div>;
}

function ConflictDialog({ conflict, onClose, onDecide }: { conflict: SyncConflictView; onClose: () => void; onDecide: (d: ConflictDecision) => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const other = conflict.remoteDevice ?? "the other device";
	const decide = async (decision: ConflictDecision) => {
		setBusy(true); setError("");
		try { await onDecide(decision); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
	};
	const side = (title: string, deleted: boolean, preview?: string, at?: string) => (
		<div className="flex-1 rounded-md border p-2">
			<p className="font-ui text-xs font-medium text-foreground">{title}</p>
			{at && <p className="text-[11px] text-muted-foreground">Changed {when(at)}</p>}
			<p className="mt-1 text-xs text-muted-foreground">{deleted ? "Deleted here" : preview ? `“${preview}”` : "Changed"}</p>
		</div>
	);
	const frame = <div className="mx-4 w-full max-w-lg rounded-xl border bg-card p-5 shadow-lg" onClick={e => e.stopPropagation()}>
		<h2 className="text-sm font-semibold text-card-foreground">{conflict.label} changed on two devices</h2>
		<p className="mt-1.5 text-xs text-muted-foreground">Choose which version to keep. Until you decide, only this item waits; everything else keeps syncing.</p>
		<div className="mt-3 flex gap-2">
			{side("This device", conflict.deletedOn === "local", conflict.localPreview)}
			{side(other, conflict.deletedOn === "remote", conflict.remotePreview, conflict.remoteAt)}
		</div>
		{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
		<div className="mt-4 flex flex-wrap justify-end gap-2">
			<button type="button" className={button} onClick={onClose} disabled={busy}>Later</button>
			{conflict.canKeepBoth && <button type="button" className={button} disabled={busy} onClick={() => void decide("both")}>Keep both</button>}
			<button type="button" className={button} disabled={busy} data-testid="keep-remote" onClick={() => void decide("remote")}>Keep {other}&apos;s</button>
			<button type="button" className={primary} disabled={busy} data-testid="keep-local" onClick={() => void decide("local")}>Keep this device&apos;s</button>
		</div>
	</div>;
	return <HostDialog open frame={frame} aria-label={`${conflict.label} conflict`} onClose={() => { onClose(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}>{frame.props.children}</HostDialog>;
}

function ForgetDialog({ publicKey, onClose, onConfirm }: { publicKey: string | null; onClose: () => void; onConfirm: () => void }) {
	const revoke = publicKey ? endpointCommands("linux", publicKey).removeDevice.code : null;
	const frame = <div className="mx-4 w-full max-w-lg rounded-xl border bg-card p-5 shadow-lg" onClick={e => e.stopPropagation()}>
		<h2 className="text-sm font-semibold text-card-foreground">Forget this endpoint?</h2>
		<p className="mt-1.5 text-xs text-muted-foreground">Sync stops, the endpoint&apos;s address is removed, and <strong>this device&apos;s key is deleted</strong>. Your progress on this device stays. To sync again later you will generate a new key and allow it on the endpoint.</p>
		{revoke && <>
			<p className="mt-3 text-xs text-muted-foreground">The endpoint still accepts the old key until you revoke it there (Linux shown; macOS/Windows variants are in the setup instructions):</p>
			<div className="mt-1"><CopyBlock code={revoke} label="Revoke this device" /></div>
		</>}
		<div className="mt-4 flex justify-end gap-2">
			<button type="button" className={button} onClick={onClose}>Cancel</button>
			<button type="button" className={danger} data-testid="forget-confirm" onClick={onConfirm}>Forget and delete key</button>
		</div>
	</div>;
	return <HostDialog open frame={frame} aria-label="Forget this endpoint?" onClose={() => { onClose(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}>{frame.props.children}</HostDialog>;
}

export function DeviceSyncSection() {
	const { status, act, probe } = useDeviceSync();
	const [host, setHost] = useState("");
	const [port, setPort] = useState("22");
	const [probed, setProbed] = useState<SyncProbeResult | null>(null);
	const [join, setJoin] = useState<JoinChoice>("merge");
	const [trusted, setTrusted] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState<SyncConflictView | null>(null);
	const [forgetting, setForgetting] = useState(false);
	const [nameDraft, setNameDraft] = useState<string | null>(null);
	/* Unconnected devices start collapsed on every visit (owner, 2026-11-15):
	 * the key is kept, the how-to opens only on request. */
	const [setupOpen, setSetupOpen] = useState(false);
	if (!status) return <p className="text-xs text-muted-foreground">Loading…</p>;

	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true); setError("");
		try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
	};
	const connected = !!status.endpoint;
	const showSetup = connected || setupOpen;

	return <div data-testid="device-sync" className="flex flex-col gap-1">
		<SettingsRow label="Status" hint={status.lastSyncAt ? `Last sync ${when(status.lastSyncAt)}` : undefined}>
			<span data-testid="sync-phase" className="font-ui text-xs text-foreground">{PHASE_LABEL[status.phase]}</span>
		</SettingsRow>
		{status.lastError && status.phase !== "in-sync" && <p role="alert" className="text-xs text-destructive">{status.lastError}</p>}
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}

		<SettingsGroup label="This device">
			<SettingsRow label="Device name" hint="Shown on your other devices">
				<input aria-label="Device name" className={input} value={nameDraft ?? status.deviceName}
					onChange={e => setNameDraft(e.currentTarget.value)}
					onBlur={() => { if (nameDraft !== null && nameDraft.trim() && nameDraft !== status.deviceName) void run(() => act("configure", { deviceName: nameDraft })); setNameDraft(null); }} />
			</SettingsRow>
			{!status.publicKey ? <SettingsRow label="Device key" hint="A key only this device holds, used to log in to the endpoint">
				<button type="button" className={primary} disabled={busy} onClick={() => void run(async () => { await act("generate-key"); setSetupOpen(true); })}>Generate device key</button>
			</SettingsRow> : !showSetup ? <SettingsRow label="Device key" hint="Ready. Set up an endpoint to start syncing">
				<button type="button" className={primary} data-testid="sync-setup-open" onClick={() => setSetupOpen(true)}>Set up Device Sync</button>
			</SettingsRow> : <>
				<p className="text-xs text-muted-foreground">This device&apos;s public key (safe to share; the private key never leaves this device):</p>
				<CopyBlock code={status.publicKey} label="Public key" />
			</>}
		</SettingsGroup>

		{status.publicKey && !connected && setupOpen && <SettingsGroup label="Set up the endpoint">
			<EndpointInstructions publicKey={status.publicKey} />
		</SettingsGroup>}

		{status.publicKey && showSetup && <SettingsGroup label="Endpoint">
			{connected ? <>
				<SettingsRow label={`${status.endpoint!.host}:${status.endpoint!.port}`} hint={`Identity ${status.endpoint!.fingerprint}`}>
					<span className="flex gap-1.5">
						{status.enabled
							? <><button type="button" className={button} disabled={busy} onClick={() => void run(() => act("sync-now"))}>Sync now</button>
								<button type="button" className={button} disabled={busy} onClick={() => void run(() => act("disconnect"))}>Disconnect</button></>
							: <button type="button" className={primary} disabled={busy} onClick={() => void run(() => act("reconnect"))}>Reconnect</button>}
						<button type="button" className={danger} disabled={busy} onClick={() => setForgetting(true)}>Forget</button>
					</span>
				</SettingsRow>
				<p className="text-xs text-muted-foreground">Disconnect pauses sync and keeps this device&apos;s key, so you can reconnect any time. Forget removes the endpoint and deletes the key.</p>
			</> : probed ? <div className="flex flex-col gap-2" data-testid="sync-confirm">
				<p className="text-xs text-foreground">The endpoint presented this identity. Check it matches the endpoint (<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on Linux/macOS):</p>
				<code className="rounded-sm bg-muted/40 px-2 py-1 font-mono text-[11px]">{probed.fingerprint}</code>
				<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.currentTarget.checked)} /> This is my endpoint</label>
				{probed.initialized && <fieldset className="flex flex-col gap-1 text-xs">
					<legend className="mb-1 text-foreground">This endpoint already holds progress from {probed.devices} device{probed.devices === 1 ? "" : "s"}. What about this device&apos;s own progress?</legend>
					<label className="flex items-start gap-2"><input type="radio" name="join" checked={join === "merge"} onChange={() => setJoin("merge")} /> <span><strong>Merge it</strong> into the shared progress (recommended)</span></label>
					<label className="flex items-start gap-2"><input type="radio" name="join" checked={join === "set-aside"} onChange={() => setJoin("set-aside")} /> <span><strong>Set it aside</strong> and use the shared progress. You can restore it later from this page.</span></label>
				</fieldset>}
				<p className="text-xs text-muted-foreground">A full backup of this device&apos;s data is taken before the first sync.</p>
				<span className="flex gap-1.5">
					<button type="button" className={button} onClick={() => { setProbed(null); setTrusted(false); }}>Back</button>
					<button type="button" className={primary} disabled={busy || !trusted} data-testid="sync-connect"
						onClick={() => void run(async () => { await act("connect", { host, port, fingerprint: probed.fingerprint, ...(probed.initialized ? { join } : {}) }); setProbed(null); setTrusted(false); })}>Connect and sync</button>
				</span>
			</div> : <div className="flex flex-wrap items-center gap-1.5">
				<input aria-label="Endpoint host or IP" placeholder="host or IP, e.g. 192.168.1.20" className={`${input} min-w-48 flex-1`} value={host} onChange={e => setHost(e.currentTarget.value)} />
				<input aria-label="Port" className={`${input} w-16`} value={port} onChange={e => setPort(e.currentTarget.value)} inputMode="numeric" />
				<button type="button" className={primary} disabled={busy || !host.trim()} onClick={() => void run(async () => setProbed(await probe(host.trim(), Number(port) || 22)))}>Check connection</button>
			</div>}
		</SettingsGroup>}

		<SettingsGroup label="What to sync on this device">
			<SettingsRow label="Sessions, knowledge graph and jobs" hint="Always synced: this is your progress"><span className="font-ui text-xs text-muted-foreground">Always</span></SettingsRow>
			{TOGGLE_LABELS.map(([key, label, hint]) => (
				<SettingsRow key={key} label={label} hint={hint}>
					<Toggle label={label} checked={status.toggles[key]} onChange={next => void run(() => act("configure", { toggles: { [key]: next } }))} />
				</SettingsRow>
			))}
			<SettingsRow label="Check for other devices' changes every" hint="Your own changes are sent within about a second">
				<ThinSelect ariaLabel="Sync interval" value={String(status.intervalSec)} onChange={v => void run(() => act("configure", { intervalSec: Number(v) }))}>
					{SYNC_INTERVALS.map(s => <option key={s} value={s}>{s} seconds</option>)}
				</ThinSelect>
			</SettingsRow>
			<p className="text-xs text-muted-foreground">API keys and provider logins never sync: each device keeps its own.</p>
		</SettingsGroup>

		{status.conflicts.length > 0 && <SettingsGroup label={`Conflicts to resolve (${status.conflicts.length})`} testid="sync-conflicts">
			{status.conflicts.map(c => (
				<SettingsRow key={c.id} label={c.label} hint={c.deletedOn ? `Deleted on ${c.deletedOn === "local" ? "this device" : c.remoteDevice ?? "another device"}, edited on the other` : `Edited on this device and on ${c.remoteDevice ?? "another device"}`}>
					<button type="button" className={primary} onClick={() => setConflict(c)}>Resolve</button>
				</SettingsRow>
			))}
		</SettingsGroup>}

		{status.devices.length > 0 && <SettingsGroup label="Devices on this endpoint">
			{status.devices.map(d => (
				<SettingsRow key={d.id} label={`${d.name}${d.self ? " (this device)" : ""}`} hint={`Last seen ${when(d.lastSeen)}`}><span /></SettingsRow>
			))}
			<p className="text-xs text-muted-foreground">To cut a device off for good, run the &quot;Revoke this device&quot; command for its key on the endpoint.</p>
		</SettingsGroup>}

		{status.setAside.length > 0 && <SettingsGroup label="Progress set aside">
			{status.setAside.map(s => (
				<SettingsRow key={s.id} label={`Set aside ${when(s.createdAt)}`} hint={`${s.files} files from before this device joined`}>
					<span className="flex gap-1.5">
						<button type="button" className={button} disabled={busy} onClick={() => void run(() => act("restore-set-aside", { id: s.id }))}>Restore into shared progress</button>
						<button type="button" className={danger} disabled={busy} onClick={() => { if (window.confirm("Delete this set-aside progress for good?")) void run(() => act("delete-set-aside", { id: s.id })); }}>Delete</button>
					</span>
				</SettingsRow>
			))}
		</SettingsGroup>}

		{conflict && <ConflictDialog conflict={conflict} onClose={() => setConflict(null)} onDecide={async d => { await act("resolve", { id: conflict.id, decision: d }); }} />}
		{forgetting && <ForgetDialog publicKey={status.publicKey} onClose={() => setForgetting(false)} onConfirm={() => { setForgetting(false); void run(() => act("forget")); }} />}
	</div>;
}
