/**
 * DOCUMENTS — shared XML and output helpers. Office XML keeps its prefixed
 * names (`w:p`, `a:t`, `text:h`) under linkedom's XML parser, so lookups use
 * the qualified tag name exactly as written in the files.
 */
import { DOMParser } from "linkedom";
import { posix } from "node:path";
import { readZipText, type ZipEntry } from "./zip.ts";

export type XmlElement = {
	tagName: string;
	children: ArrayLike<XmlElement>;
	childNodes: ArrayLike<XmlNode>;
	getAttribute(name: string): string | null;
	getElementsByTagName(name: string): ArrayLike<XmlElement>;
	textContent: string | null;
};
type XmlNode = { nodeType: number; textContent: string | null; tagName?: string };

export function parseXml(xml: string): XmlElement {
	const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as { documentElement: XmlElement | null };
	if (!doc.documentElement) throw new Error("Malformed XML part.");
	return doc.documentElement;
}

export const childElements = (element: XmlElement): XmlElement[] => Array.from(element.children);
export const child = (element: XmlElement, tag: string): XmlElement | undefined => childElements(element).find(e => e.tagName === tag);
export const descendants = (element: XmlElement, tag: string): XmlElement[] => Array.from(element.getElementsByTagName(tag));
export const first = (element: XmlElement, tag: string): XmlElement | undefined => element.getElementsByTagName(tag)[0];

/** A zip part parsed as XML, or null when the part is absent. */
export function zipXml(bytes: Uint8Array, entries: ZipEntry[], name: string): XmlElement | null {
	const text = readZipText(bytes, name, entries);
	return text === null ? null : parseXml(text);
}

export interface Relationship { target: string; type: string; external: boolean }

/** `<dir>/_rels/<file>.rels` for a part: rId → absolute in-zip target. */
export function relationships(bytes: Uint8Array, entries: ZipEntry[], part: string): Map<string, Relationship> {
	const dir = posix.dirname(part);
	const rels = zipXml(bytes, entries, posix.join(dir, "_rels", `${posix.basename(part)}.rels`));
	const map = new Map<string, Relationship>();
	if (!rels) return map;
	for (const rel of descendants(rels, "Relationship")) {
		const id = rel.getAttribute("Id"), target = rel.getAttribute("Target");
		if (!id || !target) continue;
		const external = rel.getAttribute("TargetMode") === "External";
		const resolved = external ? target : target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(dir, target));
		map.set(id, { target: resolved, type: rel.getAttribute("Type") ?? "", external });
	}
	return map;
}

/** Collects the text lines and the `[image N]` → in-zip path map. */
export class DocumentOutput {
	readonly lines: string[] = [];
	readonly images = new Map<number, string>();
	private byPath = new Map<string, number>();

	push(...lines: string[]) { this.lines.push(...lines); }
	/** Blank line between blocks, never doubled. */
	gap() { if (this.lines.length && this.lines[this.lines.length - 1] !== "") this.lines.push(""); }
	/** The placeholder for an embedded picture (one number per distinct part). */
	image(path: string): string {
		let index = this.byPath.get(path);
		if (index === undefined) {
			index = this.images.size + 1;
			this.byPath.set(path, index);
			this.images.set(index, path);
		}
		return `[image ${index}]`;
	}
	text(): string {
		while (this.lines.length && this.lines[this.lines.length - 1] === "") this.lines.pop();
		return this.lines.join("\n");
	}
}

/** A Markdown table; the first row is the header. Pipes and newlines escaped. */
export function markdownTable(rows: string[][]): string[] {
	const width = Math.max(0, ...rows.map(row => row.length));
	if (!width) return [];
	const cell = (value: string | undefined) => (value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(" | ")} |`;
	return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}

/** Spreadsheet column index (0-based) ↔ letters. */
export function columnLetters(index: number): string {
	let letters = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
	return letters;
}
export function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}
