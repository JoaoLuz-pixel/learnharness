/**
 * DOCUMENTS — Excel (.xlsx). Each sheet becomes `## Sheet: <name>` and a
 * Markdown table of its used cells, headed by column letters with a row-
 * number column, so the agent can cite cells ("B7"). Formulas show their
 * last calculated value; date-formatted numbers are shown as dates.
 * Pictures placed on a sheet follow its table as `[image N]`.
 */
import { child, childElements, columnIndex, columnLetters, descendants, DocumentOutput, first, markdownTable, relationships, zipXml, type XmlElement } from "./xml.ts";
import type { ZipEntry } from "./zip.ts";

const WORKBOOK = "xl/workbook.xml";
/** Built-in number formats that are dates/times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function extractXlsx(bytes: Uint8Array, entries: ZipEntry[]): DocumentOutput {
	const out = new DocumentOutput();
	const workbook = zipXml(bytes, entries, WORKBOOK);
	if (!workbook) throw new Error("This Excel file has no workbook part.");
	const rels = relationships(bytes, entries, WORKBOOK);
	const date1904 = first(workbook, "workbookPr")?.getAttribute("date1904") === "1";
	const shared = sharedStrings(bytes, entries);
	const dateStyles = dateStyleIndexes(bytes, entries);
	for (const sheet of descendants(workbook, "sheet")) {
		const name = sheet.getAttribute("name") ?? "Sheet";
		const path = rels.get(sheet.getAttribute("r:id") ?? "")?.target;
		const xml = path ? zipXml(bytes, entries, path) : null;
		out.gap();
		out.push(`## Sheet: ${name}`);
		out.gap();
		if (!xml || !path) { out.push("(sheet part missing)"); continue; }
		const cells = new Map<number, Map<number, string>>();
		let maxColumn = -1;
		for (const row of descendants(xml, "row")) {
			const rowNumber = Number(row.getAttribute("r"));
			for (const cell of childElements(row).filter(e => e.tagName === "c")) {
				const ref = /^([A-Z]+)(\d+)$/i.exec(cell.getAttribute("r") ?? "");
				const value = cellValue(cell, shared, dateStyles, date1904);
				if (!ref || value === "") continue;
				const column = columnIndex(ref[1]!);
				const rowIndex = Number(ref[2]) || rowNumber;
				if (!cells.has(rowIndex)) cells.set(rowIndex, new Map());
				cells.get(rowIndex)!.set(column, value);
				maxColumn = Math.max(maxColumn, column);
			}
		}
		if (!cells.size) out.push("(empty sheet)");
		else {
			const header = ["", ...Array.from({ length: maxColumn + 1 }, (_, i) => columnLetters(i))];
			const rows = [...cells.keys()].sort((a, b) => a - b).map(r => [String(r), ...Array.from({ length: maxColumn + 1 }, (_, c) => cells.get(r)!.get(c) ?? "")]);
			out.push(...markdownTable([header, ...rows]));
		}
		// Pictures: sheet → drawing → media.
		const sheetRels = relationships(bytes, entries, path);
		for (const rel of sheetRels.values()) {
			if (!rel.type.endsWith("/drawing") || rel.external) continue;
			const drawing = zipXml(bytes, entries, rel.target);
			if (!drawing) continue;
			const drawingRels = relationships(bytes, entries, rel.target);
			const pictures = descendants(drawing, "a:blip").map(blip => drawingRels.get(blip.getAttribute("r:embed") ?? "")).filter(r => r && !r.external);
			if (pictures.length) { out.gap(); out.push(pictures.map(r => out.image(r!.target)).join(" ")); }
		}
	}
	return out;
}

function sharedStrings(bytes: Uint8Array, entries: ZipEntry[]): string[] {
	const xml = zipXml(bytes, entries, "xl/sharedStrings.xml");
	if (!xml) return [];
	return descendants(xml, "si").map(richText);
}

/** <si>/<is> text: plain <t> or rich-text runs, without phonetic hints. */
function richText(element: XmlElement): string {
	const plain = child(element, "t");
	if (plain) return plain.textContent ?? "";
	return childElements(element).filter(e => e.tagName === "r").map(run => child(run, "t")?.textContent ?? "").join("");
}

function cellValue(cell: XmlElement, shared: string[], dateStyles: Set<number>, date1904: boolean): string {
	const type = cell.getAttribute("t");
	const raw = child(cell, "v")?.textContent ?? "";
	switch (type) {
		case "s": return shared[Number(raw)] ?? "";
		case "inlineStr": { const is = child(cell, "is"); return is ? richText(is) : ""; }
		case "b": return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
		case "e": case "str": return raw;
		default: {
			if (raw === "") return "";
			const style = Number(cell.getAttribute("s") ?? 0);
			const number = Number(raw);
			return dateStyles.has(style) && Number.isFinite(number) ? serialDate(number, date1904) : raw;
		}
	}
}

/** Cell style indexes (cellXfs) whose number format is a date/time. */
function dateStyleIndexes(bytes: Uint8Array, entries: ZipEntry[]): Set<number> {
	const result = new Set<number>();
	const styles = zipXml(bytes, entries, "xl/styles.xml");
	if (!styles) return result;
	const custom = new Map<number, string>();
	for (const format of descendants(styles, "numFmt")) custom.set(Number(format.getAttribute("numFmtId")), format.getAttribute("formatCode") ?? "");
	const xfs = first(styles, "cellXfs");
	if (!xfs) return result;
	childElements(xfs).filter(e => e.tagName === "xf").forEach((xf, index) => {
		const id = Number(xf.getAttribute("numFmtId") ?? 0);
		const code = custom.get(id);
		// Strip quoted text, escapes and [colors/conditions] before looking for date tokens.
		const isDate = code !== undefined ? /[dmyhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "")) : BUILTIN_DATE_FORMATS.has(id);
		if (isDate) result.add(index);
	});
	return result;
}

/** Excel serial → ISO date (time kept when present). */
export function serialDate(serial: number, date1904 = false): string {
	const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
	const date = new Date(epoch + Math.round(serial * 86400000));
	const iso = date.toISOString();
	return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}
