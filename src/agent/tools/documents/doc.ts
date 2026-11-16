/**
 * DOCUMENTS — legacy Word (.doc, the binary OLE format) via word-extractor.
 * Text only: body, then text boxes, footnotes and endnotes. The old format
 * keeps no heading structure the extractor exposes, and pictures are not
 * extracted (save as .docx to get them).
 */
import WordExtractor from "word-extractor";
import { DocumentOutput } from "./xml.ts";

/** OLE compound file signature (.doc/.xls/.ppt all share it). */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export const looksLikeOle = (bytes: Uint8Array) => OLE_SIGNATURE.every((byte, i) => bytes[i] === byte);

export async function extractDoc(bytes: Uint8Array): Promise<DocumentOutput> {
	const document = await new WordExtractor().extract(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	const out = new DocumentOutput();
	const section = (title: string | null, text: string) => {
		const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd());
		if (!lines.some(Boolean)) return;
		out.gap();
		if (title) { out.push(title); out.gap(); }
		for (const line of lines) if (line || out.lines[out.lines.length - 1] !== "") out.push(line);
	};
	section(null, document.getBody());
	section("Text boxes:", document.getTextboxes({ includeHeadersAndFooters: false, includeBody: true }));
	section("Footnotes:", document.getFootnotes());
	section("Endnotes:", document.getEndnotes());
	if (!out.lines.length) out.push("(no text)");
	return out;
}
