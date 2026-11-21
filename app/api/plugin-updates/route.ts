// Plugin updates from GitHub releases (owner, 2026-11-21). GET checks every
// community plugin whose manifest names a "repository"; POST {id} downloads
// that plugin's latest release zip and replaces its code (data/ is kept).
import { checkPluginUpdates, downloadPluginUpdate, getPluginHost, PluginInstallError, replacePluginPackage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function communityPlugins() {
	return (await getPluginHost()).list().filter(info => info.origin === "community");
}

export async function GET() {
	const plugins = await communityPlugins();
	return Response.json({ updates: await checkPluginUpdates(plugins.map(p => p.id)) });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null) as { id?: unknown } | null;
	const id = typeof body?.id === "string" ? body.id : "";
	const plugin = (await communityPlugins()).find(p => p.id === id);
	if (!plugin) return Response.json({ error: "Unknown community plugin" }, { status: 404 });
	try {
		const pkg = await downloadPluginUpdate(id);
		const { from } = replacePluginPackage(pkg);
		// Loaded code stays in memory until restart (no hot replacement).
		return Response.json({ id, from, to: pkg.manifest.version, restartRequired: plugin.enabled });
	} catch (err) {
		const status = err instanceof PluginInstallError ? 400 : 502;
		return Response.json({ error: err instanceof Error ? err.message : "Update failed" }, { status });
	}
}
