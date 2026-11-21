// Install a community plugin from a ready-built .zip (owner, 2026-11-21).
// POST the zip bytes as the body. ?mode=inspect only checks it and returns
// what it is; ?mode=install also copies it into the plugins folder. Nothing
// is run either way; the client then refreshes (and enables, if asked).
import { assertNotInstalled, inspectPluginZip, installPluginPackage, MAX_PLUGIN_ZIP_BYTES, PluginInstallError, summarizePluginPackage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const mode = new URL(request.url).searchParams.get("mode");
	if (mode !== "inspect" && mode !== "install") return Response.json({ error: "mode must be inspect or install" }, { status: 400 });
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_PLUGIN_ZIP_BYTES) return Response.json({ error: "This zip is larger than 25 MB.", code: "too-large" }, { status: 413 });
	try {
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (!bytes.byteLength) return Response.json({ error: "Choose a .zip file.", code: "invalid" }, { status: 400 });
		const pkg = inspectPluginZip(bytes);
		assertNotInstalled(pkg.manifest.id); // refuse duplicates before any dialog
		if (mode === "install") installPluginPackage(pkg);
		return Response.json({ plugin: summarizePluginPackage(pkg), installed: mode === "install" });
	} catch (err) {
		if (err instanceof PluginInstallError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "duplicate" ? 409 : err.code === "too-large" ? 413 : 400 });
		return Response.json({ error: err instanceof Error ? err.message : "Install failed" }, { status: 500 });
	}
}
