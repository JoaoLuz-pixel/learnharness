// Uninstall a community plugin (owner, 2026-11-21). GET ?id= describes what
// would be removed (zip-installed package or development/git folder); POST
// {id} first sends the plugin its uninstall trigger (it may stop the
// uninstall), then switches it off and deletes its whole folder (code and
// data). Loaded backend code stays cached until restart, so that's reported.
import { getPluginHost, installedFolderInfo, PluginInstallError, uninstallPluginFolder } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : "Uninstall failed" }, { status: err instanceof PluginInstallError ? 400 : 500 });

export async function GET(request: Request) {
	try { return Response.json(installedFolderInfo(new URL(request.url).searchParams.get("id") ?? "")); }
	catch (err) { return fail(err); }
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null) as { id?: unknown } | null;
	const id = typeof body?.id === "string" ? body.id : "";
	try {
		const host = await getPluginHost();
		const plugin = host.list().find(p => p.id === id && p.origin === "community");
		if (!plugin) throw new PluginInstallError("Unknown community plugin.");
		// 1. The uninstall trigger, before anything changes (owner, 2026-11-21):
		//    a switched-off plugin is started briefly just for it.
		const trigger = await host.prepareUninstall(id);
		if (trigger.cancelled) return Response.json({ error: `${plugin.manifest?.name ?? id} stopped the uninstall: ${trigger.cancelled}`, cancelled: true }, { status: 409 });
		// 2. Switch it off (its cleanup runs), 3. delete its folder.
		if (plugin.enabled) await host.setEnabled(id, false);
		const loaded = plugin.status === "active" || plugin.enabled || trigger.ran > 0;
		const removed = uninstallPluginFolder(id);
		await host.refresh();
		// Still listed after refresh = its server code was loaded in this process.
		const lingering = host.list().some(p => p.id === id);
		return Response.json({ id, kind: removed.kind, notes: trigger.notes, restartRequired: lingering || (loaded && !!plugin.manifest?.backend) });
	} catch (err) { return fail(err); }
}
