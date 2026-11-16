/**
 * DOCUMENTS — OpenDocument (.odt text, .ods spreadsheet, .odp slides), all
 * from content.xml. Same output conventions as the Office extractors:
 * headings, "- " lists, Markdown tables, `## Sheet:` / `## Slide N`, notes
 * as `[^n]` and pictures as `[image N]`.
 */
import { posix } from "node:path";
import { child, childElements, columnLetters, descendants, DocumentOutput, first, markdownTable, zipXml, type XmlElement } from "./xml.ts";
import type { ZipEntry } from "./zip.ts";

export type OdfKind = "text" | "spreadsheet" | "presentation";

/** Repeated empty rows/columns can claim a million cells; content never does. */
const MAX_REPEAT = 1000;

export function extractOdf(bytes: Uint8Array, entries: ZipEntry[], kind: OdfKind): DocumentOutput {
	const out = new DocumentOutput();
	const content = zipXml(bytes, entries, "content.xml");
	const body = content && first(content, `office:${kind}`);
	if (!body) throw new Error("This OpenDocument file has no content.");
	const notes: string[] = [];
	if (kind === "text") textBlocks(body, out, notes, 0);
	else if (kind === "spreadsheet") for (const table of childElements(body).filter(e => e.tagName === "table:table")) sheet(table, out);
	else slides(body, out, notes);
	if (notes.length) { out.gap(); out.push(...notes); }
	return out;
}

function imagePath(href: string | null): string | null {
	if (!href || /^[a-z]+:/i.test(href)) return null; // external links
	return posix.normalize(href.replace(/^\.\//, ""));
}

/** Inline text with spaces, tabs, breaks, notes and pictures. */
function inline(element: XmlElement, out: DocumentOutput, notes: string[]): string {
	let text = "";
	for (const node of Array.from(element.childNodes)) {
		if (node.nodeType === 3) { text += node.textContent ?? ""; continue; }
		if (node.nodeType !== 1) continue;
		const e = node as unknown as XmlElement;
		switch (e.tagName) {
			case "text:s": text += " ".repeat(Number(e.getAttribute("text:c") ?? 1) || 1); break;
			case "text:tab": text += "\t"; break;
			case "text:line-break": text += "\n"; break;
			case "text:note": {
				const id = notes.length + 1;
				const noteBody = child(e, "text:note-body");
				notes.push(`[^${id}]: ${noteBody ? descendants(noteBody, "text:p").map(p => inline(p, out, notes)).join(" ").trim() : ""}`);
				text += `[^${id}]`;
				break;
			}
			case "draw:frame": {
				const path = imagePath(first(e, "draw:image")?.getAttribute("xlink:href") ?? null);
				if (path) text += out.image(path);
				else { const box = first(e, "draw:text-box"); if (box) text += descendants(box, "text:p").map(p => inline(p, out, notes)).join(" "); }
				break;
			}
			case "office:annotation": case "text:bookmark": case "text:bookmark-start": case "text:bookmark-end": break;
			default: text += inline(e, out, notes);
		}
	}
	return text;
}

function textBlocks(container: XmlElement, out: DocumentOutput, notes: string[], depth: number) {
	for (const element of childElements(container)) {
		switch (element.tagName) {
			case "text:h": {
				const level = Math.min(6, Math.max(1, Number(element.getAttribute("text:outline-level") ?? 1) || 1));
				const text = inline(element, out, notes).trim();
				if (text) { out.gap(); out.push(`${"#".repeat(level)} ${text}`); out.gap(); }
				break;
			}
			case "text:p": { const text = inline(element, out, notes).trim(); if (text) { out.gap(); out.push(text); out.gap(); } break; }
			case "text:list": list(element, out, notes, depth); break;
			case "table:table": out.gap(); out.push(...markdownTable(tableRows(element, out, notes))); out.gap(); break;
			case "text:section": case "text:index-body": textBlocks(element, out, notes, depth); break;
		}
	}
}

function list(element: XmlElement, out: DocumentOutput, notes: string[], depth: number) {
	for (const item of childElements(element).filter(e => e.tagName === "text:list-item" || e.tagName === "text:list-header")) {
		for (const part of childElements(item)) {
			if (part.tagName === "text:list") list(part, out, notes, depth + 1);
			else if (part.tagName === "text:p" || part.tagName === "text:h") { const text = inline(part, out, notes).trim(); if (text) out.push(`${"  ".repeat(depth)}- ${text}`); }
		}
	}
}

/** Rows of cell texts, expanding repeats (capped) and trimming trailing empties. */
function tableRows(table: XmlElement, out: DocumentOutput, notes: string[]): string[][] {
	const rows: string[][] = [];
	const rowElements = (parent: XmlElement): XmlElement[] => childElements(parent).flatMap(e =>
		e.tagName === "table:table-row" ? [e] : ["table:table-rows", "table:table-header-rows", "table:table-row-group"].includes(e.tagName) ? rowElements(e) : []);
	for (const row of rowElements(table)) {
		const cells: string[] = [];
		for (const cell of childElements(row).filter(e => e.tagName === "table:table-cell" || e.tagName === "table:covered-table-cell")) {
			const text = descendants(cell, "text:p").map(p => inline(p, out, notes)).join("\n").trim();
			const repeat = Math.min(MAX_REPEAT, Number(cell.getAttribute("table:number-columns-repeated") ?? 1) || 1);
			for (let i = 0; i < repeat; i++) cells.push(text);
		}
		while (cells.length && !cells[cells.length - 1]) cells.pop();
		const repeat = Math.min(MAX_REPEAT, Number(row.getAttribute("table:number-rows-repeated") ?? 1) || 1);
		for (let i = 0; i < (cells.length ? repeat : 1); i++) rows.push([...cells]);
	}
	while (rows.length && !rows[rows.length - 1]!.length) rows.pop();
	return rows;
}

function sheet(table: XmlElement, out: DocumentOutput) {
	out.gap();
	out.push(`## Sheet: ${table.getAttribute("table:name") ?? "Sheet"}`);
	out.gap();
	const rows = tableRows(table, out, []);
	const width = Math.max(0, ...rows.map(r => r.length));
	if (!width) { out.push("(empty sheet)"); return; }
	const header = ["", ...Array.from({ length: width }, (_, i) => columnLetters(i))];
	const numbered = rows.map((row, i) => [String(i + 1), ...row]).filter(row => row.slice(1).some(Boolean));
	out.push(...markdownTable([header, ...numbered]));
	const pictures = descendants(table, "draw:image").map(image => imagePath(image.getAttribute("xlink:href"))).filter((p): p is string => !!p);
	if (pictures.length) { out.gap(); out.push(pictures.map(p => out.image(p)).join(" ")); }
}

function slides(body: XmlElement, out: DocumentOutput, notes: string[]) {
	descendants(body, "draw:page").forEach((page, index) => {
		const frames = childElements(page).filter(e => e.tagName === "draw:frame" || e.tagName === "draw:custom-shape" || e.tagName === "draw:g");
		const title = frames.find(frame => frame.getAttribute("presentation:class") === "title");
		const titleText = title ? descendants(title, "text:p").map(p => inline(p, out, notes)).join(" ").trim() : "";
		out.gap();
		out.push(`## Slide ${index + 1}${titleText ? ` — ${titleText}` : ""}`);
		out.gap();
		for (const frame of frames) {
			if (frame === title) continue;
			const image = imagePath(first(frame, "draw:image")?.getAttribute("xlink:href") ?? null);
			if (image && !first(frame, "draw:text-box")) { out.push(out.image(image)); continue; }
			const table = first(frame, "table:table");
			if (table) { out.gap(); out.push(...markdownTable(tableRows(table, out, notes))); out.gap(); continue; }
			const before = out.lines.length;
			for (const box of [first(frame, "draw:text-box") ?? frame]) {
				for (const part of childElements(box)) {
					if (part.tagName === "text:list") list(part, out, notes, 0);
					else if (part.tagName === "text:p" || part.tagName === "text:h") { const text = inline(part, out, notes).trim(); if (text) out.push(text); }
				}
			}
			if (out.lines.length > before) out.gap();
		}
		const notesElement = child(page, "presentation:notes");
		const notesText = notesElement ? childElements(notesElement).filter(e => e.tagName === "draw:frame" && e.getAttribute("presentation:class") === "notes")
			.flatMap(frame => descendants(frame, "text:p").map(p => inline(p, out, notes).trim())).filter(Boolean) : [];
		if (notesText.length) { out.gap(); out.push("Notes:", ...notesText); }
	});
}
