/**
 * CHEAT SHEETS (owner, 2026-11-26): data/cheatsheets/<chatId>.md, one per
 * session, created on the first addition or edit. Device Sync carries them
 * when its "Cheat sheets" toggle is on; deleting a session deletes its sheet.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { toString } from "mdast-util-to-string";
import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild } from "docx";
import { PATHS } from "../../config.ts";
import { appendToCheatSheet, MAX_CHEATSHEET_BYTES } from "../core/cheatsheet.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import { toHtml } from "hast-util-to-html";

export class CheatSheetError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}

function sheetFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new CheatSheetError("Unknown session", 404);
	return path.join(PATHS.cheatsheets, `${chatId}.md`);
}

/** The sheet's markdown ("" when it has none yet). */
export function readCheatSheet(chatId: string): string {
	try { return fs.readFileSync(sheetFile(chatId), "utf8"); }
	catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return ""; throw err; }
}

/** Replace the whole sheet (hand edits). An empty sheet is removed. */
export function writeCheatSheet(chatId: string, markdown: string): void {
	const file = sheetFile(chatId);
	if (Buffer.byteLength(markdown, "utf8") > MAX_CHEATSHEET_BYTES) throw new CheatSheetError("This cheat sheet is too large (over 2 MB).", 413);
	if (!markdown.trim()) { deleteCheatSheet(chatId); return; }
	fs.mkdirSync(PATHS.cheatsheets, { recursive: true });
	writeFileAtomicSync(file, markdown);
}

/** Add one answer or selection at the end, divided from the last. */
export function appendCheatSheet(chatId: string, addition: string): string {
	const next = appendToCheatSheet(readCheatSheet(chatId), addition);
	writeCheatSheet(chatId, next);
	return next;
}

export function deleteCheatSheet(chatId: string): void {
	try { fs.unlinkSync(sheetFile(chatId)); }
	catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

/* ── .docx export: headings, lists, emphasis, tables; code as monospace;
 *    math stays as its source (Word can't render the app's math). ── */

type Node = { type: string; value?: string; depth?: number; ordered?: boolean; url?: string; children?: Node[] };
const MONO = "Consolas";

function inline(nodes: Node[] | undefined, style: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): ParagraphChild[] {
	const runs: ParagraphChild[] = [];
	for (const node of nodes ?? []) {
		switch (node.type) {
			case "text": runs.push(new TextRun({ text: node.value ?? "", ...style })); break;
			case "strong": runs.push(...inline(node.children, { ...style, bold: true })); break;
			case "emphasis": runs.push(...inline(node.children, { ...style, italics: true })); break;
			case "delete": runs.push(...inline(node.children, { ...style, strike: true })); break;
			case "inlineCode": runs.push(new TextRun({ text: node.value ?? "", font: MONO, ...style })); break;
			case "break": runs.push(new TextRun({ text: "", break: 1 })); break;
			case "link": runs.push(...inline(node.children, style), new TextRun({ text: node.url ? ` (${node.url})` : "", ...style })); break;
			default: runs.push(new TextRun({ text: toString(node as never), ...style }));
		}
	}
	return runs;
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function blocks(nodes: Node[] | undefined, level = 0): (Paragraph | Table)[] {
	const out: (Paragraph | Table)[] = [];
	for (const node of nodes ?? []) {
		switch (node.type) {
			case "heading": out.push(new Paragraph({ heading: HEADINGS[Math.min(5, (node.depth ?? 1) - 1)], children: inline(node.children) })); break;
			case "paragraph": out.push(new Paragraph({ children: inline(node.children), ...(level ? { indent: { left: 360 * level } } : {}) })); break;
			case "code":
				for (const line of (node.value ?? "").split("\n")) out.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: MONO, size: 19 })], spacing: { after: 0 }, indent: { left: 360 * (level + 1) } }));
				out.push(new Paragraph({ children: [] }));
				break;
			case "math": out.push(new Paragraph({ children: [new TextRun({ text: node.value ?? "", font: MONO })], alignment: AlignmentType.CENTER })); break;
			case "thematicBreak": out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } } })); break;
			case "blockquote": out.push(...blocks(node.children, level + 1)); break;
			case "list": {
				let n = 1;
				for (const item of node.children ?? []) {
					const [first, ...rest] = item.children ?? [];
					const marker = node.ordered ? `${n++}. ` : "• ";
					out.push(new Paragraph({ children: [new TextRun({ text: marker }), ...(first?.type === "paragraph" ? inline(first.children) : inline(first ? [first] : []))], indent: { left: 360 * (level + 1), hanging: 260 } }));
					out.push(...blocks(rest, level + 1));
				}
				break;
			}
			case "table":
				out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: (node.children ?? []).map((row, r) => new TableRow({
					children: (row.children ?? []).map(cell => new TableCell({ children: [new Paragraph({ children: inline(cell.children, r === 0 ? { bold: true } : {}) })] })),
				})) }));
				out.push(new Paragraph({ children: [] }));
				break;
			case "html": out.push(new Paragraph({ children: [new TextRun({ text: node.value ?? "" })] })); break;
			default: { const text = toString(node as never); if (text.trim()) out.push(new Paragraph({ children: [new TextRun({ text })] })); }
		}
	}
	return out;
}

export async function cheatSheetDocx(markdown: string, title: string): Promise<Buffer> {
	const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node;
	const doc = new Document({
		creator: "LearnHarness", title: `${title} - cheat sheet`,
		sections: [{ children: [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }), ...blocks(tree.children)] }],
	});
	return Packer.toBuffer(doc);
}

/* ── PDF source: a standalone, light, print-ready HTML page. Raw HTML in
 *    the markdown is dropped (never executed); math renders as MathML,
 *    which Chromium draws without extra font files. ── */


const PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #1a1a1a; background: #fff; font: 11pt/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; }
h1.lh-title { font-size: 20pt; margin: 0 0 4mm; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 .45em; page-break-after: avoid; }
p, ul, ol, table, pre, blockquote { margin: 0 0 .8em; }
code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 9.5pt; background: #f1f1f1; border-radius: 3px; padding: .05em .3em; }
pre { background: #f4f4f4; border: 1px solid #e2e2e2; border-radius: 4px; padding: 3mm; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; page-break-inside: avoid; }
th, td { border: 1px solid #cfcfcf; padding: 1.5mm 2.5mm; text-align: left; vertical-align: top; }
th { background: #f1f1f1; }
blockquote { border-left: 3px solid #cfcfcf; padding-left: 3mm; color: #444; }
hr { border: 0; border-top: 1px solid #d0d0d0; margin: 5mm 0; }
a { color: #1a5fb4; }
math[display="block"] { margin: .6em 0; }`;

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch]!);

export function cheatSheetHtml(markdown: string, title: string): string {
	const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype).use(rehypeKatex as never, { output: "mathml", throwOnError: false } as never);
	const hast = processor.runSync(processor.parse(markdown));
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} - cheat sheet</title><style>${PRINT_CSS}</style></head>`
		+ `<body><h1 class="lh-title">${escapeHtml(title)}</h1>${toHtml(hast as never)}</body></html>`;
}
