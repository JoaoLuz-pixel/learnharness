// Device-only documents (owner, 2026-11-16): unsent drafts and the keyboard
// map, kept in a per-device folder because the desktop page's origin (and so
// its browser storage) changes every launch. Allowlisted keys only.
import { deleteDeviceDocument, deviceDocumentPath, MAX_DEVICE_DOCUMENT_BYTES, readDeviceDocument, writeDeviceDocument } from "@/src/server";

type Context = { params: Promise<{ key: string }> };

async function keyOf(ctx: Context): Promise<string | null> {
	const { key } = await ctx.params;
	const decoded = decodeURIComponent(key);
	return deviceDocumentPath(decoded) ? decoded : null;
}

export async function GET(_request: Request, ctx: Context) {
	const key = await keyOf(ctx);
	if (!key) return Response.json({ error: "Unknown device document" }, { status: 400 });
	const text = readDeviceDocument(key);
	return text === null ? new Response(null, { status: 204 }) : new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, ctx: Context) {
	const key = await keyOf(ctx);
	if (!key) return Response.json({ error: "Unknown device document" }, { status: 400 });
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_DEVICE_DOCUMENT_BYTES) return Response.json({ error: "Too large" }, { status: 413 });
	try { writeDeviceDocument(key, await request.text()); }
	catch (err) { return Response.json({ error: err instanceof Error ? err.message : "Invalid document" }, { status: 400 }); }
	return new Response(null, { status: 204 });
}

export async function DELETE(_request: Request, ctx: Context) {
	const key = await keyOf(ctx);
	if (!key) return Response.json({ error: "Unknown device document" }, { status: 400 });
	deleteDeviceDocument(key);
	return new Response(null, { status: 204 });
}
