/**
 * DOCUMENTS (owner plan, 2026-11-16) — what `read` does with files that are
 * neither images nor plain text: Office (.docx/.pptx/.xlsx), OpenDocument
 * (.odt/.ods/.odp), legacy Word (.doc) and plain .zip archives. The model
 * only takes text and images, so each format becomes Markdown-like text with
 * `[image N]` placeholders for its embedded pictures.
 *
 * Detection is by content, never by extension alone: a zip is classified
 * by its parts (or OpenDocument's `mimetype` entry); an OLE file is tried
 * as Word.
 */
import { posix } from "node:path";
import { extractDoc, looksLikeOle } from "./doc.ts";
import { extractDocx } from "./docx.ts";
import { extractOdf, type OdfKind } from "./odf.ts";
import { extractPptx } from "./pptx.ts";
import { extractXlsx } from "./xlsx.ts";
import { DocumentOutput } from "./xml.ts";
import { listZip, looksLikeZip, readZipText, type ZipEntry } from "./zip.ts";

export { MAX_ENTRY_BYTES, ZipError, listZip, looksLikeZip, normalizeEntryName, readZipEntry } from "./zip.ts";

export type DocumentKind = "docx" | "pptx" | "xlsx" | "odt" | "ods" | "odp" | "doc" | "zip";

export interface ReadableDocument {
	kind: DocumentKind;
	/** The full text (header line first); `read` pages it like a text file. */
	text: string;
	/** `[image N]` → the picture's path inside `container`. */
	images: Map<number, string>;
	/** The zip the picture paths point into (absent for .doc). */
	container?: Uint8Array;
}

const LABELS: Record<DocumentKind, string> = {
	docx: "Word document", pptx: "PowerPoint presentation", xlsx: "Excel workbook",
	odt: "OpenDocument text", ods: "OpenDocument spreadsheet", odp: "OpenDocument presentation",
	doc: "Word 97-2003 document", zip: "ZIP archive",
};

const ODF_TYPES: Record<string, { kind: DocumentKind; odf: OdfKind }> = {
	"application/vnd.oasis.opendocument.text": { kind: "odt", odf: "text" },
	"application/vnd.oasis.opendocument.spreadsheet": { kind: "ods", odf: "spreadsheet" },
	"application/vnd.oasis.opendocument.presentation": { kind: "odp", odf: "presentation" },
};

/** The document `read` should present, or null for "not a document" (read as text). */
export async function readDocument(bytes: Uint8Array, name: string): Promise<ReadableDocument | null> {
	if (looksLikeZip(bytes)) return readZipDocument(bytes);
	if (looksLikeOle(bytes)) {
		if (/\.(xls|xlt|ppt|pps|pot|msg)$/i.test(name)) throw new Error(legacyMessage(name));
		let out: DocumentOutput;
		try { out = await extractDoc(bytes); }
		catch { throw new Error(legacyMessage(name)); }
		return finish("doc", out);
	}
	return null;
}

function legacyMessage(name: string): string {
	return `"${posix.basename(name.replace(/\\/g, "/"))}" is a legacy Microsoft Office file (Excel 97-2003, PowerPoint 97-2003 or similar) that can't be read. Ask the learner to save it as .xlsx, .pptx or .docx.`;
}

function readZipDocument(bytes: Uint8Array): ReadableDocument {
	const entries = listZip(bytes);
	const names = new Set(entries.map(entry => entry.name));
	const mimetype = names.has("mimetype") ? readZipText(bytes, "mimetype", entries)?.trim() ?? "" : "";
	const odf = ODF_TYPES[mimetype];
	if (odf) return finish(odf.kind, extractOdf(bytes, entries, odf.odf), bytes);
	if (names.has("word/document.xml")) return finish("docx", extractDocx(bytes, entries), bytes);
	if (names.has("ppt/presentation.xml")) return finish("pptx", extractPptx(bytes, entries), bytes);
	if (names.has("xl/workbook.xml")) return finish("xlsx", extractXlsx(bytes, entries), bytes);
	return { kind: "zip", text: zipListing(entries), images: new Map() };
}

function finish(kind: DocumentKind, out: DocumentOutput, container?: Uint8Array): ReadableDocument {
	const body = out.text();
	const pictures = out.images.size ? `, ${out.images.size} picture${out.images.size === 1 ? "" : "s"}` : "";
	return { kind, text: `[${LABELS[kind]}${pictures}]\n\n${body || "(no text)"}`, images: out.images, container };
}

function size(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** The archive's table of contents; entries are read as `<archive>!/<entry>`. */
export function zipListing(entries: ZipEntry[]): string {
	const files = entries.filter(entry => !entry.directory);
	const width = Math.max(0, ...files.map(entry => entry.name.length));
	const lines = files.map(entry => `${entry.name.padEnd(width)}  ${size(entry.size).padStart(9)}${entry.encrypted ? "  (encrypted)" : ""}`);
	return [
		`[ZIP archive, ${files.length} file${files.length === 1 ? "" : "s"}. Read one with read("<this path>!/<entry>"), e.g. "course.zip!/${files[0]?.name ?? "notes.txt"}".]`,
		"",
		...(lines.length ? lines : ["(empty archive)"]),
	].join("\n");
}
