/**
 * DOCUMENTS — PowerPoint (.pptx). Slides in presentation order, each as
 * `## Slide N — <title>`, then its text (bullets by level), tables and
 * pictures in shape order, then the speaker notes.
 */
import { child, childElements, descendants, DocumentOutput, first, markdownTable, relationships, zipXml, type Relationship, type XmlElement } from "./xml.ts";
import type { ZipEntry } from "./zip.ts";

const PRESENTATION = "ppt/presentation.xml";

export function extractPptx(bytes: Uint8Array, entries: ZipEntry[]): DocumentOutput {
	const out = new DocumentOutput();
	const presentation = zipXml(bytes, entries, PRESENTATION);
	if (!presentation) throw new Error("This PowerPoint file has no presentation part.");
	const rels = relationships(bytes, entries, PRESENTATION);
	const slides = descendants(presentation, "p:sldId").map(id => rels.get(id.getAttribute("r:id") ?? "")?.target).filter((t): t is string => !!t);
	slides.forEach((path, index) => {
		const slide = zipXml(bytes, entries, path);
		if (!slide) return;
		const slideRels = relationships(bytes, entries, path);
		const tree = first(slide, "p:spTree");
		const title = tree ? shapes(tree).find(isTitle) : undefined;
		const titleText = title ? textBody(title).map(line => line.text).join(" ").trim() : "";
		out.gap();
		out.push(`## Slide ${index + 1}${titleText ? ` — ${titleText}` : ""}`);
		out.gap();
		if (tree) for (const shape of shapes(tree)) if (shape !== title) shapeContent(shape, out, slideRels);
		const notesPath = [...slideRels.values()].find(rel => rel.type.endsWith("/notesSlide"))?.target;
		const notes = notesPath ? zipXml(bytes, entries, notesPath) : null;
		const notesTree = notes && first(notes, "p:spTree");
		const notesText = notesTree ? shapes(notesTree).filter(shape => placeholderType(shape) === "body").flatMap(textBody).map(line => line.text.trim()).filter(Boolean) : [];
		if (notesText.length) { out.gap(); out.push("Notes:", ...notesText); }
	});
	return out;
}

/** Leaf shapes in document order (groups flattened). */
function shapes(tree: XmlElement): XmlElement[] {
	return childElements(tree).flatMap(element =>
		element.tagName === "p:grpSp" ? shapes(element)
			: element.tagName === "mc:AlternateContent" ? (childElements(element)[0] ? shapes(childElements(element)[0]!) : [])
				: ["p:sp", "p:pic", "p:graphicFrame"].includes(element.tagName) ? [element] : []);
}

function placeholderType(shape: XmlElement): string | null {
	const ph = first(shape, "p:ph");
	return ph ? ph.getAttribute("type") ?? "body" : null;
}
const isTitle = (shape: XmlElement) => ["title", "ctrTitle"].includes(placeholderType(shape) ?? "");

type Line = { text: string; level: number };
function textBody(shape: XmlElement): Line[] {
	const body = child(shape, "p:txBody") ?? first(shape, "a:txBody") ?? first(shape, "p:txBody");
	if (!body) return [];
	return descendants(body, "a:p").map(p => ({
		level: Number(child(p, "a:pPr")?.getAttribute("lvl") ?? 0) || 0,
		text: childElements(p).map(run => run.tagName === "a:br" ? "\n" : run.tagName === "a:r" || run.tagName === "a:fld" ? child(run, "a:t")?.textContent ?? "" : "").join(""),
	}));
}

function shapeContent(shape: XmlElement, out: DocumentOutput, rels: Map<string, Relationship>) {
	if (shape.tagName === "p:pic") {
		const id = first(shape, "a:blip")?.getAttribute("r:embed");
		const rel = id ? rels.get(id) : undefined;
		if (rel && !rel.external) { out.push(out.image(rel.target)); }
		return;
	}
	if (shape.tagName === "p:graphicFrame") {
		const table = first(shape, "a:tbl");
		if (table) {
			const rows = descendants(table, "a:tr").map(row => descendants(row, "a:tc").map(cell => textBody(cell).map(line => line.text).join("\n").trim()));
			out.gap(); out.push(...markdownTable(rows)); out.gap();
		}
		return;
	}
	const lines = textBody(shape).filter(line => line.text.trim());
	const bulleted = lines.length > 1 || (lines[0]?.level ?? 0) > 0;
	for (const line of lines) out.push(bulleted ? `${"  ".repeat(line.level)}- ${line.text.trim()}` : line.text.trim());
	// A picture used as a shape fill.
	const fill = first(shape, "a:blip")?.getAttribute("r:embed");
	const rel = fill ? rels.get(fill) : undefined;
	if (rel && !rel.external) out.push(out.image(rel.target));
	if (lines.length) out.gap();
}
