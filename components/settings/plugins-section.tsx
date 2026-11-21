"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { RefreshCw, Settings, Trash2, Upload } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection, Toggle } from "./controls";

export const PLUGIN_TRUST_WARNING = "Only enable plugins you trust. Plugins run trusted local code with broad file and network access; they are not sandboxed. A broken plugin may require restarting LearnHarness.";

/** What the server says a zip holds (app/api/plugin-install). */
export interface PluginZipSummary {
	id: string; name: string; version: string; minAppVersion: string;
	author?: string; description?: string; repository?: string; frontend: boolean; backend: boolean;
}
/** What uninstalling removes (app/api/plugin-uninstall GET). */
export interface PluginFolderView { id: string; kind: "package" | "development"; link: boolean; remote?: string; path: string }

export interface PluginUpdateView { id: string; current: string; repository: string; latest?: string; available: boolean; error?: string }

async function postZip(file: File, mode: "inspect" | "install"): Promise<PluginZipSummary> {
	const res = await fetch(`/api/plugin-install?mode=${mode}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
	const body = await res.json().catch(() => ({ error: `Request failed (${res.status})` })) as { plugin?: PluginZipSummary; error?: string };
	if (!res.ok || !body.plugin) throw new Error(body.error ?? `Request failed (${res.status})`);
	return body.plugin;
}
const isZip = (file: File) => file.name.toLowerCase().endsWith(".zip");

/**
 * Settings → Core plugins / Community plugins. Community (owner, 2026-11-21):
 * install from a ready-built .zip first (button or drop), then the installed
 * plugins with their version and any GitHub update, then the manual details
 * (folder, refresh, how-to, authoring skill) tucked into "Advanced".
 */
export function PluginsSection({ onOpenSettings, origin = "community" }: { onOpenSettings?: (pluginId: string) => void; origin?: "core" | "community" }) {
	const { manager, snapshot } = usePlugins();
	const core = origin === "core";
	const plugins = snapshot.plugins.filter(plugin => plugin.info.origin === origin);
	const [updates, setUpdates] = useState<Record<string, PluginUpdateView>>({});
	const [notice, setNotice] = useState("");
	const checkUpdates = useCallback(async () => {
		try {
			const res = await fetch("/api/plugin-updates", { cache: "no-store" });
			if (!res.ok) return;
			const { updates: list } = await res.json() as { updates: PluginUpdateView[] };
			setUpdates(Object.fromEntries(list.map(u => [u.id, u])));
		} catch { /* offline: no update notices */ }
	}, []);
	const communityIds = core ? "" : plugins.map(p => `${p.info.id}@${p.info.manifest?.version ?? ""}`).join(",");
	useEffect(() => { if (!core && communityIds) void checkUpdates(); }, [core, communityIds, checkUpdates]);

	const list = snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
		: plugins.length === 0 ? <p className="text-xs text-muted-foreground">{core ? "No Core plugins available." : "No community plugins installed yet."}</p>
			: plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin} update={updates[plugin.info.id]}
				onSettings={() => onOpenSettings?.(plugin.info.id)}
				onUpdated={(text) => { setNotice(text); void checkUpdates(); }} />);

	return <SettingsSection title={core ? "Core plugins" : "Community plugins"} testid={core ? "section-core-plugins" : "section-plugins"}>
		{!core && <InstallBar onInstalled={setNotice} />}
		{notice && <p role="status" data-testid="plugin-notice" className="text-xs text-foreground">{notice}</p>}
		{!core && snapshot.conflicts.map(conflict => <p role="alert" key={conflict.id} className="break-words text-xs text-destructive">{conflict.error}</p>)}
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{list}
		{!core && <details data-testid="plugin-advanced" className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
			<summary className="w-fit cursor-pointer list-none uppercase tracking-widest text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">Advanced</summary>
			<div className="mt-3 space-y-3">
				<details data-testid="plugin-install-help" className="text-xs text-muted-foreground">
					<summary className="w-fit cursor-pointer list-none text-muted-foreground underline underline-offset-2 hover:text-foreground [&::-webkit-details-marker]:hidden">How to install a plugin</summary>
					<ol className="mt-2 list-decimal space-y-2 pl-5">
						<li>Clone or copy the plugin into the directory below, using its plugin ID as the folder name.</li>
						<li>For source projects, follow the repository’s dependency setup and run <code>npm run build</code>. Prebuilt packages already contain <code>dist/manifest.json</code> and need no build.</li>
						<li>Refresh the list, then enable the plugin. New plugins are disabled by default.</li>
						<li>Restart LearnHarness after changing loaded code. Preserve <code>data/</code> beside <code>dist/</code> when updating.</li>
					</ol>
				</details>
				<div data-testid="plugin-authoring-help" className="space-y-2 border-t border-border/60 pt-3">
					<h3 className="text-xs uppercase tracking-widest">Build a plugin</h3>
					<p className="font-prose text-sm text-muted-foreground">Download the authoring skill for your coding agent.</p>
					<Button variant="outline" size="sm" asChild><a href="/plugin-authoring/learnharness-plugins.zip" download={`learnharness-plugins-${process.env.LH_VERSION ?? "authoring"}.zip`} data-testid="download-plugin-authoring">Download authoring skill</a></Button>
				</div>
				<div data-testid="plugin-directory" className="border-t border-border/60 pt-3">
					<p className="text-xs text-muted-foreground">Plugins directory</p>
					<div className="mt-1 flex items-center gap-3">
						<code className="min-w-0 flex-1 break-all text-xs select-text">{snapshot.directory}</code>
						<Button variant="outline" size="icon-sm" aria-label="Refresh plugins" title="Refresh plugins" aria-busy={snapshot.refreshing}
							disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
							<RefreshCw aria-hidden="true" className={snapshot.refreshing ? "animate-spin" : undefined} />
						</Button>
					</div>
				</div>
			</div>
		</details>}
	</SettingsSection>;
}

/** The install entry point: a file picker button, and dropping a .zip on it. */
function InstallBar({ onInstalled }: { onInstalled: (text: string) => void }) {
	const { manager } = usePlugins();
	const input = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [summary, setSummary] = useState<PluginZipSummary | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [over, setOver] = useState(false);

	const choose = async (picked: File | undefined) => {
		setError(""); onInstalled("");
		if (!picked) return;
		if (!isZip(picked)) { setError("Choose a .zip file containing a built plugin."); return; }
		setBusy(true);
		try { setSummary(await postZip(picked, "inspect")); setFile(picked); }
		catch (err) { setError((err as Error).message); }
		finally { setBusy(false); if (input.current) input.current.value = ""; }
	};
	const install = async (enable: boolean) => {
		if (!file || !summary) return;
		await postZip(file, "install");
		setSummary(null); setFile(null);
		await manager?.refresh();
		if (enable) await manager?.setEnabled(summary.id, true);
		onInstalled(`${summary.name} v${summary.version} installed${enable ? " and enabled" : ". Switch it on below when you're ready"}.`);
	};
	const drop = (event: DragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault(); event.stopPropagation(); setOver(false);
		void choose(event.dataTransfer.files[0]);
	};

	return <div data-testid="plugin-install" onDragOver={e => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
		onDragLeave={() => setOver(false)} onDrop={drop}
		className={`flex flex-col gap-2 rounded-md border border-dashed p-3 transition-colors ${over ? "border-primary bg-primary/5" : "border-border"}`}>
		<div className="flex flex-wrap items-center gap-3">
			<Button type="button" size="sm" data-testid="plugin-install-button" disabled={busy || !manager} onClick={() => input.current?.click()}>
				<Upload aria-hidden="true" className="size-3.5" />{busy ? "Checking…" : "Install plugin from file…"}
			</Button>
			<span className="text-xs text-muted-foreground">or drop a plugin <code>.zip</code> here</span>
			<input ref={input} type="file" accept=".zip,application/zip" hidden aria-hidden="true" tabIndex={-1} onChange={e => void choose(e.currentTarget.files?.[0])} />
		</div>
		<p className="text-xs text-muted-foreground">Only install plugins you trust: they run with your account&apos;s access and aren&apos;t sandboxed. Nothing runs until you enable it.</p>
		{error && <p role="alert" data-testid="plugin-install-error" className="break-words text-xs text-destructive">{error}</p>}
		{summary && <InstallDialog summary={summary} onCancel={() => { setSummary(null); setFile(null); }} onInstall={install} />}
	</div>;
}

export function InstallDialogBody({ summary, onCancel, onInstall }: { summary: PluginZipSummary; onCancel: () => void; onInstall: (enable: boolean) => Promise<void> }) {
	const [enable, setEnable] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const go = async () => {
		setBusy(true); setError("");
		try { await onInstall(enable); } catch (err) { setError((err as Error).message); setBusy(false); }
	};
	return <div data-testid="plugin-install-dialog">
		<h2 className="text-sm font-semibold text-card-foreground">Install {summary.name}?</h2>
		<dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
			<dt className="text-muted-foreground">Version</dt><dd data-testid="install-version">{summary.version}</dd>
			{summary.author && <><dt className="text-muted-foreground">Author</dt><dd>{summary.author}</dd></>}
			<dt className="text-muted-foreground">Plugin id</dt><dd><code>{summary.id}</code></dd>
			<dt className="text-muted-foreground">Runs</dt><dd>{[summary.frontend && "in the app window", summary.backend && "on the app's server (files and network)"].filter(Boolean).join(" and ")}</dd>
			{summary.repository && <><dt className="text-muted-foreground">Updates</dt><dd>from github.com/{summary.repository}</dd></>}
		</dl>
		{summary.description && <p className="mt-3 font-prose text-sm text-muted-foreground">{summary.description}</p>}
		<p className="mt-3 text-xs text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>
		<label className="mt-3 flex items-center gap-2 text-xs text-foreground">
			<input type="checkbox" data-testid="install-enable" checked={enable} onChange={e => setEnable(e.currentTarget.checked)} /> Enable after installing
		</label>
		{error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{error}</p>}
		<div className="mt-4 flex justify-end gap-2">
			<Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
			<Button type="button" size="sm" data-testid="install-confirm" onClick={() => void go()} disabled={busy}>{busy ? "Installing…" : "Install"}</Button>
		</div>
	</div>;
}

function InstallDialog(props: { summary: PluginZipSummary; onCancel: () => void; onInstall: (enable: boolean) => Promise<void> }) {
	const frame = <div className="mx-4 w-full max-w-md rounded-xl border bg-card p-5 shadow-lg" onClick={e => e.stopPropagation()} />;
	return <HostDialog open frame={frame} aria-label={`Install ${props.summary.name}`} onClose={() => { props.onCancel(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}><InstallDialogBody {...props} /></HostDialog>;
}

function PluginRow({ plugin, update, onSettings, onUpdated }: { plugin: FrontendPlugin; update?: PluginUpdateView; onSettings: () => void; onUpdated: (text: string) => void }) {
	const { manager, snapshot } = usePlugins();
	const { info } = plugin;
	const name = info.manifest?.name ?? info.id;
	const [updating, setUpdating] = useState(false);
	const [updateError, setUpdateError] = useState("");
	const [uninstalling, setUninstalling] = useState(false);
	const runUpdate = async () => {
		if (!update?.latest || !window.confirm(`Update ${name} from v${update.current} to v${update.latest}? Its saved data is kept.`)) return;
		setUpdating(true); setUpdateError("");
		try {
			const res = await fetch("/api/plugin-updates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: info.id }) });
			const body = await res.json().catch(() => ({})) as { error?: string; to?: string; restartRequired?: boolean };
			if (!res.ok) throw new Error(body.error ?? `Update failed (${res.status})`);
			await manager?.refresh();
			onUpdated(`${name} updated to v${body.to}.${body.restartRequired ? " Restart LearnHarness to use the new version." : ""}`);
		} catch (err) { setUpdateError((err as Error).message); }
		finally { setUpdating(false); }
	};
	const status = plugin.busy ? "Saving…" : plugin.error ? "Error" : plugin.phase === "loading" ? "Loading…" : info.enabled ? "Enabled" : "Disabled";
	return <div className="border-t border-border/60 pt-3" data-testid={`plugin-${info.id}`}>
		<SettingsRow label={name} hint={[info.origin === "community" && info.manifest?.author ? `by ${info.manifest.author}` : undefined, status].filter(Boolean).join(" · ")}>
			<div className="flex shrink-0 items-center gap-2">
				{info.origin === "community" && info.manifest?.version && <span data-testid="plugin-version" className="rounded-sm border border-border px-1.5 py-0.5 font-ui text-[11px] text-muted-foreground">v{info.manifest.version}</span>}
				{info.enabled && <button type="button" aria-label={`Settings for ${name}`} title={`Settings for ${name}`}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onSettings}><Settings className="size-3.5" aria-hidden="true" /></button>}
				<Toggle label={`Enable ${name}`} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
				{info.origin === "community" && <button type="button" aria-label={`Uninstall ${name}`} title={`Uninstall ${name}`} data-testid="plugin-uninstall"
					disabled={!manager || plugin.busy || snapshot.refreshing}
					className="flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
					onClick={() => setUninstalling(true)}><Trash2 className="size-3.5" aria-hidden="true" /></button>}
			</div>
		</SettingsRow>
		{uninstalling && <UninstallDialog id={info.id} name={name} version={info.manifest?.version} enabled={info.enabled} backend={!!info.manifest?.backend}
			onClose={() => setUninstalling(false)} onDone={(text) => { setUninstalling(false); onUpdated(text); }} />}
		{info.manifest?.description && <p className="mt-1 font-prose text-sm text-muted-foreground">{info.manifest.description}</p>}
		{update?.available && <div data-testid="plugin-update" className="mt-2 flex flex-wrap items-center gap-2 text-xs">
			<span className="text-foreground">Update available: v{update.latest}</span>
			<Button type="button" variant="outline" size="xs" disabled={updating || snapshot.refreshing} onClick={() => void runUpdate()}>{updating ? "Updating…" : "Update"}</Button>
		</div>}
		{update?.error && !update.available && <p className="mt-1 text-[11px] text-muted-foreground">Update check: {update.error}</p>}
		{updateError && <p role="alert" className="mt-1 break-words text-xs text-destructive">{updateError}</p>}
		{plugin.error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{plugin.error}</p>}
	</div>;
}

/** The uninstall confirmation: always deletes code AND data (owner's choice);
 *  a development folder (git clone / source) gets its own explanation. */
export function UninstallDialogBody({ name, version, folder, busy, error, onCancel, onConfirm, startsBriefly = false }: {
	name: string; version?: string; folder: PluginFolderView | null; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
	/** Switched off but has a server part: it runs briefly for its uninstall trigger. */
	startsBriefly?: boolean;
}) {
	return <div data-testid="plugin-uninstall-dialog">
		<h2 className="text-sm font-semibold text-card-foreground">Uninstall {name}{version ? ` v${version}` : ""}?</h2>
		{!folder ? <p className="mt-2 text-xs text-muted-foreground">{error ? "" : "Checking its folder…"}</p>
			: folder.kind === "development" ? <div className="mt-2 space-y-2 text-xs text-muted-foreground">
				<p>This plugin is a <strong className="text-foreground">local copy of a git repository</strong> (a development folder). Its folder, including the source code and git history, is deleted from this computer. The repository online is not touched, so you can clone it again later.</p>
				{folder.remote && <p>Repository: <code className="break-all text-foreground">{folder.remote}</code></p>}
				<p>Changes in this folder that were never pushed are lost. Its saved data is deleted too.</p>
			</div>
			: <p className="mt-2 text-xs text-muted-foreground">{folder.link ? "This plugin's folder is a link: the link is removed, the folder it points to is kept. " : ""}Its code and all the data it saved are deleted. Installing it again later starts fresh.</p>}
		{folder && startsBriefly && <p data-testid="uninstall-starts-briefly" className="mt-2 text-xs text-muted-foreground">{name} will run briefly to clean up before it&apos;s removed.</p>}
		{folder && <p className="mt-2 break-all text-[11px] text-muted-foreground">Folder: <code>{folder.path}</code></p>}
		{error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{error}</p>}
		<div className="mt-4 flex justify-end gap-2">
			<Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
			<Button type="button" variant="destructive" size="sm" data-testid="uninstall-confirm" onClick={onConfirm} disabled={busy || !folder}>{busy ? "Uninstalling…" : "Uninstall"}</Button>
		</div>
	</div>;
}

function UninstallDialog({ id, name, version, enabled, backend, onClose, onDone }: { id: string; name: string; version?: string; enabled: boolean; backend: boolean; onClose: () => void; onDone: (text: string) => void }) {
	const { manager } = usePlugins();
	const [folder, setFolder] = useState<PluginFolderView | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		fetch(`/api/plugin-uninstall?id=${encodeURIComponent(id)}`, { cache: "no-store" })
			.then(async res => { const body = await res.json() as PluginFolderView & { error?: string }; if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`); if (live) setFolder(body); })
			.catch(err => { if (live) setError((err as Error).message); });
		return () => { live = false; };
	}, [id]);
	const confirm = async () => {
		setBusy(true); setError("");
		try {
			// The server sends the plugin its uninstall trigger FIRST (it may stop
			// the uninstall), then switches it off and deletes it.
			const res = await fetch("/api/plugin-uninstall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
			const body = await res.json().catch(() => ({})) as { error?: string; restartRequired?: boolean; notes?: string[] };
			if (!res.ok) throw new Error(body.error ?? `Uninstall failed (${res.status})`);
			await manager?.refresh();
			onDone([`${name} was uninstalled.`, ...(body.notes ?? []), body.restartRequired ? "Restart LearnHarness to finish removing it." : ""].filter(Boolean).join(" "));
		} catch (err) { setError((err as Error).message); setBusy(false); }
	};
	const frame = <div className="mx-4 w-full max-w-md rounded-xl border bg-card p-5 shadow-lg" onClick={e => e.stopPropagation()} />;
	return <HostDialog open frame={frame} aria-label={`Uninstall ${name}`} onClose={() => { if (!busy) onClose(); return "closed"; }}
		backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}>
		<UninstallDialogBody name={name} version={version} folder={folder} busy={busy} error={error} onCancel={onClose} onConfirm={() => void confirm()} startsBriefly={!enabled && backend} />
	</HostDialog>;
}
