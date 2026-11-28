"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, LockIcon } from "lucide-react";
import { SYNC_INTERVALS, endpointCommands, removeSyncCommand, type CloudFolderSuggestionView, type ConflictDecision, type DeviceSyncStatus, type EndpointOs, type JoinChoice, type SyncChoiceView, type SyncConflictView, type SyncEndpointTarget, type SyncEndpointView, type SyncProbeResult, type SyncTarget } from "@/src/core";
import { SettingsGroup, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";
import { useDeviceSync } from "@/components/use-device-sync";
import { HostDialog } from "@/components/host-dialog";

/**
 * DEVICE SYNC (owner design, 2026-11-15): one endpoint keeps every
 * device's progress merged. Everything a person needs is on this page: where
 * to sync (a cloud folder, another device's host or an SSH endpoint, or this
 * device's own host — owner, 2026-11-28), the device key and copyable
 * endpoint commands per OS, connect / disconnect / forget, sync passwords,
 * what to sync, conflicts to resolve, set-aside progress.
 */
export const PHASE_LABEL: Record<DeviceSyncStatus["phase"], string> = {
	off: "Off", connecting: "Connecting…", syncing: "Syncing…", "in-sync": "In sync", offline: "Offline — working locally, retrying", blocked: "Blocked — the endpoint's identity changed",
};
const TOGGLE_LABELS = [
	["layout", "Graph layout", "Node positions on the graph map"],
	["settings", "Settings", "General, appearance, models and graph settings"],
	["plugins", "Plugins & their data", "Which plugins are on, and what they store"],
	["promptsThemes", "Prompt overrides & themes", "Your custom teacher prompts and themes"],
	["cheatsheets", "Cheat sheets", "Each session's cheat sheet"],
] as const;

const button = "whitespace-nowrap rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "whitespace-nowrap rounded-sm border border-primary bg-primary px-3 py-1.5 font-ui text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const danger = "whitespace-nowrap rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 font-ui text-xs text-destructive transition-colors hover:bg-destructive/20";
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

/** What the chooser has picked: an existing sync, or a new one with a name.
 *  Passwords (owner, 2026-11-28): to join a protected sync, or to protect
 *  a new one (typed twice). */
export interface SyncPick { mode: "join" | "create"; joinId: string | null; name: string; join: JoinChoice; password?: string; confirm?: string; protect?: boolean }
/** What the endpoint allows (from the probe, or the connected endpoint's kind). */
export interface ChooserRules { canCreate: boolean; passwordRequired: boolean; kind: SyncProbeResult["kind"] }
const DEFAULT_RULES: ChooserRules = { canCreate: true, passwordRequired: false, kind: "ssh" };
export const rulesFor = (endpoint: SyncEndpointView | null): ChooserRules => ({
	kind: endpoint?.kind ?? "ssh", canCreate: endpoint?.kind !== "host", passwordRequired: endpoint?.kind === "host" || endpoint?.kind === "self" });
export const MIN_PASSWORD = 8;
export const initialPick = (syncs: SyncChoiceView[], deviceName: string, exclude?: string | null, rules: ChooserRules = DEFAULT_RULES): SyncPick => {
	const joinable = syncs.filter(sync => sync.id !== exclude);
	return { mode: joinable.length || !rules.canCreate ? "join" : "create", joinId: joinable.length === 1 ? joinable[0]!.id : null, name: `${deviceName}'s sync`, join: "merge",
		...(rules.passwordRequired ? { protect: true } : {}) };
};
/** The target to send, or null while the pick is incomplete. */
export function pickTarget(pick: SyncPick, syncs: SyncChoiceView[] = [], rules: ChooserRules = DEFAULT_RULES): SyncTarget | null {
	if (pick.mode === "create") {
		if (!rules.canCreate || !pick.name.trim()) return null;
		if (!(pick.protect || rules.passwordRequired)) return { kind: "create", name: pick.name.trim() };
		const password = pick.password ?? "";
		return password.length >= MIN_PASSWORD && password === pick.confirm ? { kind: "create", name: pick.name.trim(), password } : null;
	}
	if (!pick.joinId) return null;
	if (syncs.find(sync => sync.id === pick.joinId)?.locked) return pick.password ? { kind: "join", id: pick.joinId, password: pick.password } : null;
	return { kind: "join", id: pick.joinId };
}

function RemoveSyncHelp({ syncId }: { syncId: string }) {
	return <details className="mt-1 text-[11px] text-muted-foreground">
		<summary className="cursor-pointer select-none">Remove this sync from the endpoint (by hand)</summary>
		<p className="mt-1">The app never deletes a sync. If nobody uses this one any more, run the command for the endpoint&apos;s system. {removeSyncCommand("linux", syncId).note}</p>
		{(["linux", "macos", "windows"] as const).map(os => (
			<div key={os} className="mt-1">
				<p>{os === "linux" ? "Linux" : os === "macos" ? "macOS" : "Windows (PowerShell)"}</p>
				<CopyBlock code={removeSyncCommand(os, syncId).code} label={`Remove sync on ${os}`} />
			</div>
		))}
	</details>;
}

/** The endpoint words for notes ("this folder", "this endpoint"…). */
const placeWord = (kind: ChooserRules["kind"]) => kind === "folder" ? "this cloud folder" : kind === "host" || kind === "self" ? "this host" : "this endpoint";

/**
 * The sync chooser (owner, 2026-11-20): every sync on the endpoint with the
 * devices paired to it, then Join one or Create my own. Joining asks the
 * one-time question about this device's own progress. A protected sync
 * shows only its name and a lock, and asks for its password (2026-11-28).
 */
export function SyncChooser({ syncs, pick, onPick, currentSyncId, rules = DEFAULT_RULES }: { syncs: SyncChoiceView[]; pick: SyncPick; onPick: (next: SyncPick) => void; currentSyncId?: string | null; rules?: ChooserRules }) {
	const set = (patch: Partial<SyncPick>) => onPick({ ...pick, ...patch });
	const picked = syncs.find(sync => sync.id === pick.joinId);
	const protect = rules.passwordRequired || !!pick.protect;
	return <div data-testid="sync-chooser" className="flex flex-col gap-2 text-xs">
		{syncs.length === 0
			? <p className="text-foreground">{rules.canCreate ? `${placeWord(rules.kind).replace(/^this/, "This")} has no syncs yet. Create the first one; your other devices can join it.` : "This host has no syncs yet. Create one on the host PC (Host sync on this device), then join it here."}</p>
			: <p className="text-foreground">{placeWord(rules.kind).replace(/^this/, "This")} holds {syncs.length === 1 ? "a sync" : `${syncs.length} syncs`}. {rules.canCreate ? "Join one, or create your own." : "Join one with its password."}</p>}
		{syncs.map(sync => {
			const current = sync.id === currentSyncId;
			return <label key={sync.id} data-testid="sync-option" className={`flex items-start gap-2 rounded-md border p-2 ${current ? "opacity-60" : ""}`}>
				<input type="radio" name="sync-pick" disabled={current} checked={pick.mode === "join" && pick.joinId === sync.id} onChange={() => set({ mode: "join", joinId: sync.id, password: "" })} />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex items-center gap-1 font-medium text-foreground">{sync.locked && <LockIcon aria-label="Password protected" className="size-3" />}{sync.name}{current ? " (this device's sync)" : ""}</span>
					{sync.locked && !sync.devices
						? <span className="text-muted-foreground">Password protected. Its devices and progress show once you join.</span>
						: <>
							{sync.createdBy && <span className="text-muted-foreground">Created by {sync.createdBy} · {when(sync.createdAt)}</span>}
							{sync.devices?.length
								? <span className="text-muted-foreground">Devices: {sync.devices.map(d => `${d.name} (last seen ${when(d.lastSeen)})`).join(", ")}</span>
								: <span className="text-muted-foreground">No devices yet</span>}
						</>}
					{rules.kind === "ssh" && !sync.id.startsWith("p_") && <RemoveSyncHelp syncId={sync.id} />}
				</span>
			</label>;
		})}
		{rules.canCreate && <label data-testid="sync-option-create" className="flex items-start gap-2 rounded-md border p-2">
			<input type="radio" name="sync-pick" checked={pick.mode === "create"} onChange={() => set({ mode: "create" })} />
			<span className="flex flex-1 flex-col gap-1">
				<span className="font-medium text-foreground">Create my own sync</span>
				<span className="text-muted-foreground">It starts from this device&apos;s progress. Other devices can join it later.</span>
				{pick.mode === "create" && <>
					<input aria-label="Sync name" maxLength={60} className={input} value={pick.name} onChange={e => set({ name: e.currentTarget.value })} />
					{!rules.passwordRequired && <label className="flex items-center gap-2"><input type="checkbox" data-testid="sync-protect" checked={!!pick.protect} onChange={e => set({ protect: e.currentTarget.checked })} /> Protect it with a password</label>}
					{protect && <PasswordFields pick={pick} set={set} kind={rules.kind} />}
				</>}
			</span>
		</label>}
		{pick.mode === "join" && picked?.locked && <label className="flex flex-col gap-1">
			<span className="text-foreground">Password for &ldquo;{picked.name}&rdquo;</span>
			<input type="password" aria-label="Sync password" data-testid="sync-join-password" autoComplete="current-password" className={input} value={pick.password ?? ""} onChange={e => set({ password: e.currentTarget.value })} />
			<span className="text-muted-foreground">Typed once: this device remembers it in the system&apos;s secure storage.</span>
		</label>}
		{pick.mode === "join" && pick.joinId && <fieldset className="flex flex-col gap-1">
			<legend className="mb-1 text-foreground">What about this device&apos;s own progress?</legend>
			<label className="flex items-start gap-2"><input type="radio" name="join" checked={pick.join === "merge"} onChange={() => set({ join: "merge" })} /> <span><strong>Merge it</strong> into the sync&apos;s progress (recommended)</span></label>
			<label className="flex items-start gap-2"><input type="radio" name="join" checked={pick.join === "set-aside"} onChange={() => set({ join: "set-aside" })} /> <span><strong>Set it aside</strong> and use the sync&apos;s progress. You can restore it later from this page.</span></label>
		</fieldset>}
	</div>;
}

/** A new sync's password, typed twice, with what it means (owner, 2026-11-28). */
function PasswordFields({ pick, set, kind }: { pick: SyncPick; set: (patch: Partial<SyncPick>) => void; kind: ChooserRules["kind"] }) {
	const password = pick.password ?? "", confirm = pick.confirm ?? "";
	return <div data-testid="sync-password-fields" className="flex flex-col gap-1">
		<input type="password" aria-label="New sync password" autoComplete="new-password" placeholder={`Password (at least ${MIN_PASSWORD} characters)`} className={input} value={password} onChange={e => set({ password: e.currentTarget.value })} />
		<input type="password" aria-label="Repeat the password" autoComplete="new-password" placeholder="Repeat the password" className={input} value={confirm} onChange={e => set({ confirm: e.currentTarget.value })} />
		{password.length > 0 && password.length < MIN_PASSWORD && <span className="text-destructive">At least {MIN_PASSWORD} characters.</span>}
		{confirm.length > 0 && confirm !== password && <span className="text-destructive">The two passwords differ.</span>}
		<span className="text-muted-foreground">Everything this sync stores is encrypted with it: nobody can read it without the password. It can&apos;t be changed later. If every device forgets it, the copy in {placeWord(kind)} can&apos;t be recovered (each device keeps its own progress).</span>
		{kind !== "self" && <span className="text-muted-foreground">Anyone who can reach {placeWord(kind)} without the password can&apos;t read the sync, but could still delete its files there.</span>}
	</div>;
}

function ChangeSyncDialog({ status, onClose, listSyncs, onConfirm }: { status: DeviceSyncStatus; onClose: () => void; listSyncs: () => Promise<SyncChoiceView[]>; onConfirm: (target: SyncTarget, join?: JoinChoice) => Promise<void> }) {
	const [syncs, setSyncs] = useState<SyncChoiceView[] | null>(null);
	const [pick, setPick] = useState<SyncPick | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const deviceName = status.deviceName, currentId = status.sync?.id;
	const rules = rulesFor(status.endpoint);
	const kind = status.endpoint?.kind;
	useEffect(() => {
		let live = true;
		listSyncs().then(list => { if (live) { setSyncs(list); setPick(initialPick(list, deviceName, currentId, rulesFor(kind ? { kind } as SyncEndpointView : null))); } })
			.catch(err => { if (live) setError((err as Error).message); });
		return () => { live = false; };
	}, [listSyncs, deviceName, currentId, kind]);
	const target = pick && syncs ? pickTarget(pick, syncs, rules) : null;
	const confirm = async () => {
		if (!target || !pick) return;
		setBusy(true); setError("");
		try { await onConfirm(target, target.kind === "join" ? pick.join : undefined); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
	};
	const frame = <div className="mx-4 flex max-h-[85dvh] w-full max-w-lg flex-col rounded-xl border bg-card p-5 shadow-lg" onClick={e => e.stopPropagation()}>
		<h2 className="text-sm font-semibold text-card-foreground">Change sync</h2>
		<p className="mt-1.5 text-xs text-muted-foreground">This device leaves &ldquo;{status.sync?.name}&rdquo;, which keeps its progress for its other devices. A full backup of this device&apos;s data is taken first, and this device keeps its key.</p>
		<div className="mt-3 min-h-0 overflow-y-auto">
			{syncs && pick ? <SyncChooser syncs={syncs} pick={pick} onPick={setPick} currentSyncId={status.sync?.id} rules={rules} /> : !error && <p className="text-xs text-muted-foreground">Checking the endpoint…</p>}
		</div>
		{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
		<div className="mt-4 flex justify-end gap-2">
			<button type="button" className={button} onClick={onClose} disabled={busy}>Cancel</button>
			<button type="button" className={primary} data-testid="change-sync-confirm" disabled={busy || !target} onClick={() => void confirm()}>{target?.kind === "create" ? "Create and switch" : "Switch"}</button>
		</div>
	</div>;
	return <HostDialog open frame={frame} aria-label="Change sync" onClose={() => { onClose(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}>{frame.props.children}</HostDialog>;
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

/** The endpoint's one-line label (connected). */
export function endpointLabel(endpoint: SyncEndpointView): { label: string; hint: string } {
	if (endpoint.kind === "folder") return { label: "Cloud folder", hint: endpoint.path };
	if (endpoint.kind === "self") return { label: "This device's host", hint: "Synced straight from this device's disk" };
	return { label: `${endpoint.host}:${endpoint.port}`, hint: `${endpoint.kind === "host" ? "Another device's host" : "SSH endpoint"} · identity ${endpoint.fingerprint}` };
}

type ConnectWay = "folder" | "address" | "self";

/** Where to sync: pick the way, check it, confirm its identity, then choose a sync. */
function ConnectPanel({ status, busy, run, probe, act }: { status: DeviceSyncStatus; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void>;
	probe: (target: SyncEndpointTarget) => Promise<SyncProbeResult>; act: ReturnType<typeof useDeviceSync>["act"] }) {
	const [way, setWay] = useState<ConnectWay>("folder");
	const [host, setHost] = useState("");
	const [port, setPort] = useState("");
	const [folder, setFolder] = useState("");
	const [suggestions, setSuggestions] = useState<CloudFolderSuggestionView[] | null>(null);
	const [probed, setProbed] = useState<{ result: SyncProbeResult; target: SyncEndpointTarget } | null>(null);
	const [pick, setPick] = useState<SyncPick | null>(null);
	const [trusted, setTrusted] = useState(false);
	const [sshHelp, setSshHelp] = useState(false);
	useEffect(() => {
		if (way !== "folder" || suggestions) return;
		let live = true;
		act<{ folders: CloudFolderSuggestionView[] }>("cloud-folders").then(r => { if (live) setSuggestions(r.folders); }).catch(() => { if (live) setSuggestions([]); });
		return () => { live = false; };
	}, [way, suggestions, act]);
	const reset = () => { setProbed(null); setPick(null); setTrusted(false); };
	const check = (target: SyncEndpointTarget) => run(async () => {
		const result = await probe(target);
		const rules: ChooserRules = { kind: result.kind, canCreate: result.canCreate, passwordRequired: result.passwordRequired };
		setProbed({ result, target }); setPick(initialPick(result.syncs, status.deviceName, null, rules)); setTrusted(!result.fingerprint);
	});
	if (probed && pick) {
		const { result, target } = probed;
		const rules: ChooserRules = { kind: result.kind, canCreate: result.canCreate, passwordRequired: result.passwordRequired };
		const syncTarget = pickTarget(pick, result.syncs, rules);
		const endpoint: SyncEndpointView = target.kind === "folder" ? { kind: "folder", path: target.path } : target.kind === "self" ? { kind: "self" }
			: { kind: result.kind === "host" ? "host" : "ssh", host: target.host, port: target.port, fingerprint: result.fingerprint ?? "" };
		return <div className="flex flex-col gap-2" data-testid="sync-confirm">
			{result.fingerprint && <>
				<p className="text-xs text-foreground">{result.kind === "host"
					? <>This is another device&apos;s LearnHarness host. Check that its identity matches the one shown under <strong>Host sync on this device</strong> on that device:</>
					: <>The endpoint presented this identity. Check it matches the endpoint (<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on Linux/macOS):</>}</p>
				<code className="rounded-sm bg-muted/40 px-2 py-1 font-mono text-[11px]">{result.fingerprint}</code>
				<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.currentTarget.checked)} /> {result.kind === "host" ? "This is my other device" : "This is my endpoint"}</label>
			</>}
			{result.kind === "folder" && <p className="text-xs text-muted-foreground">Syncs live in a &ldquo;LearnHarness Sync&rdquo; folder inside it. Your cloud app copies it to your other devices, so changes can take a little while to arrive.</p>}
			<SyncChooser syncs={result.syncs} pick={pick} onPick={setPick} rules={rules} />
			<p className="text-xs text-muted-foreground">A full backup of this device&apos;s data is taken before the first sync.</p>
			<span className="flex gap-1.5">
				<button type="button" className={button} onClick={reset}>Back</button>
				<button type="button" className={primary} disabled={busy || !trusted || !syncTarget} data-testid="sync-connect"
					onClick={() => void run(async () => {
						await act("connect", { endpoint, target: syncTarget, ...(syncTarget!.kind === "join" ? { join: pick.join } : {}) });
						reset();
					})}>Connect and sync</button>
			</span>
		</div>;
	}
	return <div className="flex flex-col gap-2">
		<div role="tablist" aria-label="Where to sync" className="flex flex-wrap gap-1">
			{([["folder", "Cloud folder"], ["address", "Another device or SSH endpoint"], ["self", "This device's host"]] as const).map(([id, label]) => (
				<button key={id} type="button" role="tab" data-testid={`sync-way-${id}`} aria-selected={way === id} onClick={() => setWay(id)} className={way === id ? primary : button}>{label}</button>
			))}
		</div>
		{way === "folder" && <div className="flex flex-col gap-1.5" data-testid="sync-folder">
			<p className="text-xs text-muted-foreground">Sync through OneDrive, iCloud Drive, Dropbox or Google Drive: pick the folder their app keeps on this computer. The app must be installed and signed in on every device; nothing else to set up.</p>
			{suggestions && suggestions.length > 0 && <span className="flex flex-wrap gap-1">
				{suggestions.map(f => <button key={f.path} type="button" className={button} title={f.path} onClick={() => setFolder(f.path)}>{f.provider}</button>)}
			</span>}
			<span className="flex flex-wrap items-center gap-1.5">
				<input aria-label="Cloud folder" placeholder="e.g. C:\Users\you\OneDrive" className={`${input} min-w-48 flex-1`} value={folder} onChange={e => setFolder(e.currentTarget.value)} />
				{typeof window !== "undefined" && window.lh?.chooseAttachmentFolder && <button type="button" className={button} onClick={() => void window.lh!.chooseAttachmentFolder!().then(p => { if (p) setFolder(p); })}>Browse…</button>}
				<button type="button" className={primary} disabled={busy || !folder.trim()} onClick={() => void check({ kind: "folder", path: folder.trim() })}>Check folder</button>
			</span>
		</div>}
		{way === "address" && <div className="flex flex-col gap-1.5" data-testid="sync-address">
			<p className="text-xs text-muted-foreground">Another device hosting with LearnHarness (port 7419 unless it was changed there; use its Tailscale address when it is on another network), or an SSH endpoint you set up (port 22).</p>
			<span className="flex flex-wrap items-center gap-1.5">
				<input aria-label="Endpoint host or IP" placeholder="host or IP, e.g. 100.101.102.103" className={`${input} min-w-48 flex-1`} value={host} onChange={e => setHost(e.currentTarget.value)} />
				<input aria-label="Port" placeholder="7419" className={`${input} w-16`} value={port} onChange={e => setPort(e.currentTarget.value)} inputMode="numeric" />
				<button type="button" className={primary} disabled={busy || !host.trim()} onClick={() => void check({ kind: "address", host: host.trim(), port: Number(port) || 7419 })}>Check connection</button>
			</span>
			<button type="button" className="self-start text-[11px] text-muted-foreground underline" onClick={() => setSshHelp(open => !open)}>{sshHelp ? "Hide" : "Set up"} an SSH endpoint</button>
			{sshHelp && <div className="flex flex-col gap-2 rounded-md border p-2">
				{!status.publicKey
					? <button type="button" className={`${primary} self-start`} disabled={busy} onClick={() => void run(() => act("generate-key"))}>Generate device key</button>
					: <>
						<p className="text-xs text-muted-foreground">This device&apos;s public key (safe to share; the private key never leaves this device):</p>
						<CopyBlock code={status.publicKey} label="Public key" />
						<EndpointInstructions publicKey={status.publicKey} />
					</>}
			</div>}
		</div>}
		{way === "self" && <div className="flex flex-col gap-1.5" data-testid="sync-self">
			{status.host.enabled
				? <>
					<p className="text-xs text-muted-foreground">This device takes part in one of the syncs it hosts, straight from its own disk.</p>
					<button type="button" className={`${primary} self-start`} disabled={busy} onClick={() => void check({ kind: "self" })}>Choose a sync</button>
				</>
				: <p className="text-xs text-muted-foreground">Turn on <strong>Host sync on this device</strong> below first.</p>}
		</div>}
	</div>;
}

/** "Host sync on this device" (owner, 2026-11-28). */
function HostSection({ status, busy, run, act }: { status: DeviceSyncStatus; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void>; act: ReturnType<typeof useDeviceSync>["act"] }) {
	const host = status.host;
	const [portDraft, setPortDraft] = useState<string | null>(null);
	const [creating, setCreating] = useState<SyncPick | null>(null);
	const createTarget = creating ? pickTarget(creating, [], { kind: "self", canCreate: true, passwordRequired: true }) : null;
	return <SettingsGroup label="Host sync on this device" testid="sync-host">
		<SettingsRow label="Host sync on this device" hint="Your other devices sync with this one, over your network or Tailscale">
			<Toggle label="Host sync on this device" checked={host.enabled} onChange={next => void run(() => act("host", { enabled: next }))} />
		</SettingsRow>
		{host.enabled && <>
			{host.error && <p role="alert" className="text-xs text-destructive">{host.error}</p>}
			<SettingsRow label="Status" hint="It runs while LearnHarness is open. Closing the window keeps it in the tray while hosting">
				<span data-testid="sync-host-state" className="font-ui text-xs text-foreground">{host.running ? "Hosting" : "Not running"}</span>
			</SettingsRow>
			<SettingsRow label="Port" hint="Other devices use this port with this device's address">
				<input aria-label="Host port" className={`${input} w-20`} inputMode="numeric" value={portDraft ?? String(host.port)} onChange={e => setPortDraft(e.currentTarget.value)}
					onBlur={() => { if (portDraft !== null && Number(portDraft) !== host.port) void run(() => act("host", { port: Number(portDraft) })); setPortDraft(null); }} />
			</SettingsRow>
			<div className="flex flex-col gap-1" data-testid="sync-host-addresses">
				<p className="text-xs text-foreground">Addresses to type on your other devices (Connect → Another device or SSH endpoint):</p>
				{host.addresses.length === 0 && <p className="text-xs text-muted-foreground">No network address found. Connect this device to a network, or start Tailscale.</p>}
				{host.addresses.map(a => (
					<div key={a.address} className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-[11px] text-muted-foreground">{a.kind === "tailscale" ? "Tailscale (any network)" : "Local network"}</span>
						<div className="min-w-0 flex-1"><CopyBlock code={a.address.includes(":") ? `[${a.address}]` : a.address} label={`${a.kind} address`} /></div>
					</div>
				))}
				<p className="text-[11px] text-muted-foreground">Identity to check on the other device: <code className="font-mono">{host.fingerprint}</code></p>
			</div>
			<details className="text-xs text-muted-foreground" data-testid="sync-tailscale-guide">
				<summary className="cursor-pointer select-none text-foreground">Devices on other networks: use Tailscale</summary>
				<ol className="mt-1 list-decimal pl-5">
					<li>Install Tailscale (free for personal use, tailscale.com) on this device and on each other device, and sign in with the same account everywhere.</li>
					<li>Once it is connected, a Tailscale address (100.x.y.z) shows above. Type it on your other devices, with the port above.</li>
					<li>That&apos;s all: Tailscale reaches this device from any network without opening your router, and nothing is exposed to the internet.</li>
				</ol>
				<p className="mt-1">On the local network, the first time, Windows may ask whether LearnHarness may accept connections: allow it for private networks.</p>
			</details>
			<div className="flex flex-col gap-1">
				<p className="text-xs text-foreground">Syncs hosted here</p>
				{host.syncs.length === 0 && <p className="text-xs text-muted-foreground">None yet. Create one; other devices then join it with its password.</p>}
				{host.syncs.map(sync => (
					<SettingsRow key={sync.id} label={sync.name} hint={`${sync.members} other device${sync.members === 1 ? "" : "s"} joined · password protected`}><LockIcon aria-hidden className="size-3 text-muted-foreground" /></SettingsRow>
				))}
				{creating ? <div className="flex flex-col gap-1.5 rounded-md border p-2" data-testid="sync-host-create">
					<input aria-label="Sync name" maxLength={60} className={input} value={creating.name} onChange={e => setCreating({ ...creating, name: e.currentTarget.value })} />
					<PasswordFields pick={creating} set={patch => setCreating({ ...creating, ...patch })} kind="self" />
					<span className="flex gap-1.5">
						<button type="button" className={button} onClick={() => setCreating(null)}>Cancel</button>
						<button type="button" className={primary} disabled={busy || !createTarget} onClick={() => void run(async () => { await act("host-create-sync", { name: createTarget!.kind === "create" ? createTarget!.name : "", password: createTarget!.password }); setCreating(null); })}>Create sync</button>
					</span>
					<p className="text-[11px] text-muted-foreground">To sync this device too, choose Connect → This device&apos;s host and join it.</p>
				</div> : <button type="button" className={`${button} self-start`} data-testid="sync-host-new" onClick={() => setCreating({ mode: "create", joinId: null, name: `${status.deviceName}'s sync`, join: "merge", protect: true })}>Create a sync</button>}
			</div>
		</>}
	</SettingsGroup>;
}

export function DeviceSyncSection() {
	const { status, act, probe, listSyncs } = useDeviceSync();
	const [changing, setChanging] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [conflict, setConflict] = useState<SyncConflictView | null>(null);
	const [forgetting, setForgetting] = useState(false);
	const [nameDraft, setNameDraft] = useState<string | null>(null);
	/* Unconnected devices start collapsed on every visit (owner, 2026-11-15):
	 * the how-to opens only on request. */
	const [setupOpen, setSetupOpen] = useState(false);
	if (!status) return <p className="text-xs text-muted-foreground">Loading…</p>;

	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true); setError("");
		try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
	};
	const connected = !!status.endpoint;
	const showSetup = connected || setupOpen;
	const label = status.endpoint ? endpointLabel(status.endpoint) : null;

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
			{!showSetup && <SettingsRow label="Device Sync" hint="Share your progress with your other devices">
				<button type="button" className={primary} data-testid="sync-setup-open" onClick={() => setSetupOpen(true)}>Set up Device Sync</button>
			</SettingsRow>}
		</SettingsGroup>

		{showSetup && <SettingsGroup label={connected ? "Endpoint" : "Connect"}>
			{connected && label ? <>
				<SettingsRow label={label.label} hint={label.hint}>
					<span className="flex shrink-0 gap-2">
						{status.enabled
							? <><button type="button" className={button} disabled={busy} onClick={() => void run(() => act("sync-now"))}>Sync now</button>
								<button type="button" className={button} disabled={busy} onClick={() => void run(() => act("disconnect"))}>Disconnect</button></>
							: <button type="button" className={primary} disabled={busy} onClick={() => void run(() => act("reconnect"))}>Reconnect</button>}
						<button type="button" className={danger} disabled={busy} onClick={() => setForgetting(true)}>Forget</button>
					</span>
				</SettingsRow>
				{status.sync && <SettingsRow label="Sync" hint={status.sync.locked ? "Password protected: encrypted wherever it is stored. Any device in it can rename it" : "The progress this device shares. Any device in it can rename it"}>
					{renaming === null ? <span className="flex shrink-0 items-center gap-2">
						{status.sync.locked && <LockIcon aria-label="Password protected" className="size-3 text-muted-foreground" />}
						<span data-testid="sync-name" className="whitespace-nowrap font-ui text-xs text-foreground">{status.sync.name}</span>
						<button type="button" className={button} disabled={busy} onClick={() => setRenaming(status.sync!.name)}>Rename</button>
						<button type="button" className={button} disabled={busy} data-testid="change-sync" onClick={() => setChanging(true)}>Change sync</button>
					</span> : <span className="flex shrink-0 items-center gap-2">
						<input aria-label="Sync name" maxLength={60} className={input} value={renaming} onChange={e => setRenaming(e.currentTarget.value)} />
						<button type="button" className={primary} disabled={busy || !renaming.trim()} onClick={() => void run(async () => { await act("rename-sync", { name: renaming }); setRenaming(null); })}>Save</button>
						<button type="button" className={button} disabled={busy} onClick={() => setRenaming(null)}>Cancel</button>
					</span>}
				</SettingsRow>}
				<p className="text-xs text-muted-foreground">Disconnect pauses sync and keeps this device&apos;s key and passwords, so you can reconnect any time. Change sync moves this device to another sync on the same endpoint. Forget removes the endpoint and deletes the key and remembered passwords.</p>
			</> : <ConnectPanel status={status} busy={busy} run={run} probe={probe} act={act} />}
		</SettingsGroup>}

		{(showSetup || status.host.enabled) && <HostSection status={status} busy={busy} run={run} act={act} />}

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

		{status.devices.length > 0 && <SettingsGroup label={status.sync ? `Devices in “${status.sync.name}”` : "Devices in this sync"}>
			{status.devices.map(d => (
				<SettingsRow key={d.id} label={`${d.name}${d.self ? " (this device)" : ""}`} hint={`Last seen ${when(d.lastSeen)}`}><span /></SettingsRow>
			))}
			{status.endpoint?.kind === "ssh" && <p className="text-xs text-muted-foreground">To cut a device off for good, run the &quot;Revoke this device&quot; command for its key on the endpoint.</p>}
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
		{changing && <ChangeSyncDialog status={status} listSyncs={listSyncs} onClose={() => setChanging(false)}
			onConfirm={async (target, join) => { await act("change-sync", { target, ...(join ? { join } : {}) }); }} />}
		{forgetting && <ForgetDialog publicKey={status.endpoint?.kind === "ssh" ? status.publicKey : null} onClose={() => setForgetting(false)} onConfirm={() => { setForgetting(false); void run(() => act("forget")); }} />}
	</div>;
}
