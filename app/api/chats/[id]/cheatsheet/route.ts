// A session's cheat sheet (owner, 2026-11-26).
// GET → { markdown, title }; GET ?export=md|txt|docx → the file as a download.
// PUT { markdown } replaces it (hand edits); POST { append } adds an answer
// or a selection at the end. PDF is made by the desktop shell (print page).
import { cheatSheetFileName, cheatSheetPlainText } from "@/src/core";
import { appendCheatSheet, cheatSheetDocx, cheatSheetHtml, CheatSheetError, getChat, readCheatSheet, writeCheatSheet } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : "Cheat sheet request failed" }, { status: err instanceof CheatSheetError ? err.status : 500 });
const download = (body: BodyInit, type: string, name: string) => new Response(body, { headers: {
	"Content-Type": type, "Cache-Control": "no-store",
	"Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
} });

async function session(params: Promise<{ id: string }>) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) throw new CheatSheetError("No such session", 404);
	return { id, title: chat.title || "Session" };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id, title } = await session(params);
		const markdown = readCheatSheet(id);
		const format = new URL(request.url).searchParams.get("export");
		if (format === "md") return download(markdown, "text/markdown; charset=utf-8", cheatSheetFileName(title, "md"));
		if (format === "txt") return download(cheatSheetPlainText(markdown), "text/plain; charset=utf-8", cheatSheetFileName(title, "txt"));
		if (format === "docx") return download(new Uint8Array(await cheatSheetDocx(markdown, title)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", cheatSheetFileName(title, "docx"));
		// The PDF's source: printed by the desktop shell in a hidden window.
		if (format === "html") return new Response(cheatSheetHtml(markdown, title), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
		if (format) throw new CheatSheetError("Unknown export format");
		return Response.json({ markdown, title }, { headers: { "Cache-Control": "no-store" } });
	} catch (err) { return fail(err); }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await session(params);
		const body = await request.json().catch(() => null) as { markdown?: unknown } | null;
		if (typeof body?.markdown !== "string") throw new CheatSheetError("Expected { markdown }");
		writeCheatSheet(id, body.markdown);
		return new Response(null, { status: 204 });
	} catch (err) { return fail(err); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await session(params);
		const body = await request.json().catch(() => null) as { append?: unknown } | null;
		if (typeof body?.append !== "string" || !body.append.trim()) throw new CheatSheetError("Nothing to add");
		appendCheatSheet(id, body.append);
		return Response.json({ ok: true });
	} catch (err) { return fail(err); }
}
