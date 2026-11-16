/**
 * DOCUMENTS — Word (.docx). Headings come from the paragraph style (named
 * "heading N"/"Title" in styles.xml, so localized style ids still work) or
 * an outline level; list paragraphs become "- " items indented by level;
 * tables become Markdown tables; pictures become `[image N]`; footnotes and
 * endnotes are appended as `[^n]: …`.
 */
import { child, childElements, descendants, DocumentOutput, first, markdownTable, relationships, zipXml, type XmlElement } from "./xml.ts";
import type { ZipEntry } from "./zip.ts";

const MAIN = "word/document.xml";

export function extractDocx(bytes: Uint8Array, entries: ZipEntry[]): DocumentOutput {
	const out = new DocumentOutput();
	const document = zipXml(bytes, entries, MAIN);
	const body = document && first(document, "w:body");
	if (!body) throw new Error("This Word file has no document body.");
	const headingLevels = styleHeadingLevels(bytes, entries);
	const rels = relationships(bytes, entries, MAIN);
	const notes: string[] = [];
	const context: Context = { out, rels, headingLevels };

	for (const kind of ["footnote", "endnote"] as const) {
		const part = zipXml(bytes, entries, `word/${kind}s.xml`);
		if (!part) continue;
		const partRels = relationships(bytes, entries, `word/${kind}s.xml`);
		for (const note of descendants(part, `w:${kind}`)) {
			const type = note.getAttribute("w:type");
			if (type && type !== "normal") continue; // separators
			const text = descendants(note, "w:p").map(p => paragraphText(p, { ...context, rels: partRels })).join(" ").trim();
			if (text) notes.push(`[^${kind === "endnote" ? "e" : ""}${note.getAttribute("w:id")}]: ${text}`);
		}
	}

	blocks(body, context);
	if (notes.length) { out.gap(); out.push(...notes); }
	return out;
}

type Context = { out: DocumentOutput; rels: ReturnType<typeof relationships>; headingLevels: Map<string, number> };

function blocks(container: XmlElement, context: Context) {
	for (const element of childElements(container)) {
		if (element.tagName === "w:p") paragraph(element, context);
		else if (element.tagName === "w:tbl") { context.out.gap(); context.out.push(...markdownTable(tableRows(element, context))); context.out.gap(); }
		else if (element.tagName === "w:sdt") { const content = child(element, "w:sdtContent"); if (content) blocks(content, context); }
	}
}

function paragraph(p: XmlElement, context: Context) {
	const text = paragraphText(p, context).trim();
	if (!text) return;
	const props = child(p, "w:pPr");
	const style = props && child(props, "w:pStyle")?.getAttribute("w:val");
	const outline = props && child(props, "w:outlineLvl")?.getAttribute("w:val");
	const level = (style ? context.headingLevels.get(style) : undefined) ?? (outline != null ? Number(outline) + 1 : undefined);
	const list = props && child(props, "w:numPr");
	if (level && level >= 1 && level <= 6) { context.out.gap(); context.out.push(`${"#".repeat(level)} ${text}`); context.out.gap(); }
	else if (list) {
		const depth = Number(child(list, "w:ilvl")?.getAttribute("w:val") ?? 0) || 0;
		context.out.push(`${"  ".repeat(depth)}- ${text}`);
	} else { context.out.gap(); context.out.push(text); context.out.gap(); }
}

/** Runs in order: text, tabs, breaks, pictures, note references. */
export function paragraphText(p: XmlElement, context: Pick<Context, "out" | "rels">): string {
	let text = "";
	const walk = (element: XmlElement) => {
		for (const node of childElements(element)) {
			switch (node.tagName) {
				case "w:t": text += node.textContent ?? ""; break;
				case "w:tab": text += "\t"; break;
				case "w:br": case "w:cr": text += "\n"; break;
				case "w:footnoteReference": text += `[^${node.getAttribute("w:id")}]`; break;
				case "w:endnoteReference": text += `[^e${node.getAttribute("w:id")}]`; break;
				case "w:drawing": case "w:pict": case "w:object": {
					for (const id of pictureIds(node)) {
						const rel = context.rels.get(id);
						if (rel && !rel.external) text += context.out.image(rel.target);
					}
					break;
				}
				case "mc:AlternateContent": { const choice = childElements(node)[0]; if (choice) walk(choice); break; } // Choice and Fallback repeat the same content
				case "w:delText": case "w:instrText": case "w:rPr": case "w:pPr": break; // deletions, field codes, formatting
				default: walk(node);
			}
		}
	};
	walk(p);
	return text;
}

function pictureIds(element: XmlElement): string[] {
	return [
		...descendants(element, "a:blip").map(blip => blip.getAttribute("r:embed")),
		...descendants(element, "v:imagedata").map(data => data.getAttribute("r:id")),
	].filter((id): id is string => !!id);
}

function tableRows(table: XmlElement, context: Context): string[][] {
	return childElements(table).filter(e => e.tagName === "w:tr").map(row =>
		childElements(row).filter(e => e.tagName === "w:tc").map(cell =>
			descendants(cell, "w:p").map(p => paragraphText(p, context).trim()).filter(Boolean).join("\n")));
}

/** styleId → heading level, from the style NAMES (ids are localized). */
function styleHeadingLevels(bytes: Uint8Array, entries: ZipEntry[]): Map<string, number> {
	const levels = new Map<string, number>();
	for (let n = 1; n <= 6; n++) levels.set(`Heading${n}`, n);
	levels.set("Title", 1);
	const styles = zipXml(bytes, entries, "word/styles.xml");
	if (!styles) return levels;
	for (const style of descendants(styles, "w:style")) {
		const id = style.getAttribute("w:styleId");
		const name = child(style, "w:name")?.getAttribute("w:val")?.toLowerCase() ?? "";
		const outline = first(style, "w:outlineLvl")?.getAttribute("w:val");
		const heading = /^heading (\d)$/.exec(name);
		const level = heading ? Number(heading[1]) : name === "title" ? 1 : outline != null ? Number(outline) + 1 : undefined;
		if (id && level !== undefined && level <= 6) levels.set(id, level);
	}
	return levels;
}
