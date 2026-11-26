/**
 * Cheat sheets (owner, 2026-11-26): one markdown sheet per session, built
 * from answers and edited by hand; deleted with the session; exported as
 * PDF (print HTML), .docx, .md and .txt.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cheatsheet-"));
process.env.LH_DATA_DIR = path.join(root, "data");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const core = await import("../src/core/cheatsheet.ts");
const sheets = await import("../src/server/cheatsheets.ts");
const { stores } = await import("../src/server/stores.ts");
const { deleteIdleChatRecord } = await import("../src/server/chats.ts");
const route = await import("../app/api/chats/[id]/cheatsheet/route.ts");
const { SessionRow } = await import("../components/sidebar.tsx");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, init?: RequestInit, query = "") => new Request(`http://localhost/api/chats/${id}/cheatsheet${query}`, init);

describe("adding and plain text", () => {
	it("appends answers with a divider, ignoring blank additions", () => {
		assert.equal(core.appendToCheatSheet("", "  ## TCP\\n\\ncode  "), "## TCP\\n\\ncode\n");
		assert.equal(core.appendToCheatSheet("## TCP\n", "## UDP"), "## TCP\n\n---\n\n## UDP\n");
		assert.equal(core.appendToCheatSheet("## TCP\n", "   "), "## TCP\n");
	});
	it("plain text keeps words, code and table cells, without markdown symbols", () => {
		const text = core.cheatSheetPlainText("## Serveur **TCP**\n\n```java\ntry (x) {}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n");
		assert.match(text, /^Serveur TCP$/m);
		assert.match(text, /^try \(x\) \{\}$/m);
		assert.match(text, /^1\t2$/m);
		assert.match(text, /^- one$/m);
		assert.doesNotMatch(text, /##|\*\*|```/);
	});
	it("export file names are safe", () => {
		assert.equal(core.cheatSheetFileName("DAI: TE/blanc?", "pdf"), "DAI TE blanc - cheat sheet.pdf");
		assert.equal(core.cheatSheetFileName("   ", "md"), "Session - cheat sheet.md");
	});
});

describe("storage, with the session", () => {
	it("one file per session; empty removes it; refuses odd ids and oversize", () => {
		sheets.appendCheatSheet("chat_a", "## One");
		sheets.appendCheatSheet("chat_a", "## Two");
		assert.equal(sheets.readCheatSheet("chat_a"), "## One\n\n---\n\n## Two\n");
		assert.ok(fs.existsSync(path.join(root, "data", "cheatsheets", "chat_a.md")));
		sheets.writeCheatSheet("chat_a", "  ");
		assert.equal(fs.existsSync(path.join(root, "data", "cheatsheets", "chat_a.md")), false);
		assert.equal(sheets.readCheatSheet("chat_a"), "");
		assert.throws(() => sheets.readCheatSheet("../auth"), /Unknown session/);
		assert.throws(() => sheets.writeCheatSheet("chat_a", "x".repeat(core.MAX_CHEATSHEET_BYTES + 1)), /too large/);
	});
	it("deleting a session deletes its cheat sheet", () => {
		const chat = stores.chatStore.createChat("DAI");
		sheets.appendCheatSheet(chat.id, "keep?");
		assert.deepEqual(deleteIdleChatRecord(chat.id), { ok: true });
		assert.equal(sheets.readCheatSheet(chat.id), "");
	});
});

describe("the cheat sheet API", () => {
	it("reads, appends, replaces, and exports .md / .txt / .docx / print HTML", async () => {
		const chat = stores.chatStore.createChat("DAI: TE");
		assert.deepEqual(await (await route.GET(req(chat.id), params(chat.id))).json(), { markdown: "", title: "DAI: TE" });
		assert.equal((await route.POST(req(chat.id, { method: "POST", body: JSON.stringify({ append: "## Serveur TCP\n\n$x^2$" }) }), params(chat.id))).status, 200);
		assert.equal((await route.POST(req(chat.id, { method: "POST", body: JSON.stringify({ append: "  " }) }), params(chat.id))).status, 400);
		assert.equal((await route.PUT(req(chat.id, { method: "PUT", body: JSON.stringify({ markdown: "## Edited\n\n<script>alert(1)</script>\n\n$$x^2$$\n" }) }), params(chat.id))).status, 204);
		const md = await route.GET(req(chat.id, undefined, "?export=md"), params(chat.id));
		assert.match(md.headers.get("content-disposition") ?? "", /attachment; filename="DAI TE - cheat sheet.md"/);
		assert.match(await md.text(), /## Edited/);
		assert.match(await (await route.GET(req(chat.id, undefined, "?export=txt"), params(chat.id))).text(), /^Edited$/m);
		const docx = new Uint8Array(await (await route.GET(req(chat.id, undefined, "?export=docx"), params(chat.id))).arrayBuffer());
		assert.equal(String.fromCharCode(docx[0]!, docx[1]!), "PK", "a real .docx (zip)");
		const html = await (await route.GET(req(chat.id, undefined, "?export=html"), params(chat.id))).text();
		assert.doesNotMatch(html, /<script/i, "raw HTML is never carried into the print page");
		assert.match(html, /<math/, "math renders as MathML");
		assert.match(html, /<h1 class="lh-title">DAI: TE<\/h1>/);
		assert.equal((await route.GET(req("chat_missing"), params("chat_missing"))).status, 404);
	});
});

describe("the sidebar", () => {
	it("every session row carries the cheat-sheet icon when opening is wired", () => {
		const chat = { id: "chat_x", title: "DAI", createdAt: "", updatedAt: "" } as never;
		const html = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} onOpenCheatSheet={() => {}} />);
		assert.match(html, /data-testid="session-cheatsheet"/);
		assert.match(html, /aria-label="Open the cheat sheet for DAI"/);
		assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*<button/s, "no nested buttons");
	});
});
