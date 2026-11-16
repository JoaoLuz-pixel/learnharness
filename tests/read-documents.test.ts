/**
 * read() for documents (owner plan, 2026-11-16): Office, OpenDocument,
 * legacy .doc handling and .zip archives with "<file>!/<entry>" paths.
 * Fixtures are built in memory with fflate — tiny but structurally real
 * parts, so the extractors run on the same XML shapes Office writes.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { createCanvas } from "@napi-rs/canvas";
import { createReadTool, MAX_DOCUMENT_IMAGES, readTool } from "../src/agent/tools/read.ts";
import { listZip, MAX_ENTRY_BYTES, readZipEntry } from "../src/agent/tools/documents/index.ts";
import { serialDate } from "../src/agent/tools/documents/xlsx.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-read-docs-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function png(color = "#c00"): Uint8Array {
	const canvas = createCanvas(4, 4);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, 4, 4);
	return new Uint8Array(canvas.toBuffer("image/png"));
}

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data])));
}

function save(name: string, bytes: Uint8Array): string {
	const file = path.join(tmp, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
	return file;
}

type Result = { text: string; images: { data: string; mimeType: string }[] };
async function read(args: { path: string; offset?: number; limit?: number }, tool = readTool): Promise<Result> {
	const result = await tool.execute!("test", args);
	const text = result.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
	const images = result.content.filter(part => part.type === "image") as unknown as Result["images"];
	return { text, images };
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const rels = (items: [string, string, string?][]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, target, type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`;
const wp = (text: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const picture = (id: string) => `<w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></w:drawing></w:r>`;

function docx(body: string, extra: Record<string, string | Uint8Array> = {}, relItems: [string, string, string?][] = [["rId5", "media/image1.png"]]) {
	return zip({
		"[Content_Types].xml": "<Types/>",
		"word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
		"word/_rels/document.xml.rels": rels(relItems),
		"word/styles.xml": `<w:styles ${W}><w:style w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Ttulo2"><w:name w:val="heading 2"/></w:style></w:styles>`,
		"word/media/image1.png": png(),
		...extra,
	});
}

describe("read — Word (.docx)", () => {
	it("keeps headings (localized style ids), paragraphs, lists, tables, pictures and footnotes", async () => {
		const file = save("lecture.docx", docx([
			wp("Linear maps", '<w:pStyle w:val="Ttulo1"/>'),
			`<w:p><w:r><w:t>A map is linear when</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`,
			wp("additive", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
			wp("homogeneous", '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
			`<w:tbl><w:tr><w:tc>${wp("Map")}</w:tc><w:tc>${wp("Linear?")}</w:tc></w:tr><w:tr><w:tc>${wp("x | 2x")}</w:tc><w:tc>${wp("yes")}</w:tc></w:tr></w:tbl>`,
			`<w:p>${picture("rId5")}</w:p>`,
			`<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><a:blip r:embed="rId5"/></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
		].join(""), {
			"word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1">${wp("----")}</w:footnote><w:footnote w:id="1">${wp("See chapter 2.")}</w:footnote></w:footnotes>`,
		}));
		const { text, images } = await read({ path: file });
		assert.match(text, /^\[Word document, 1 picture\]/);
		assert.match(text, /^# Linear maps$/m);
		assert.match(text, /^A map is linear when\[\^1\]$/m);
		assert.match(text, /^- additive\n {2}- homogeneous$/m);
		assert.match(text, /^\| Map \| Linear\? \|\n\| --- \| --- \|\n\| x \\\| 2x \| yes \|$/m);
		assert.equal(text.match(/\[image 1\]/g)?.length, 3, "one number per picture; AlternateContent is not doubled (2 in the body + the attachment note)");
		assert.match(text, /^\[\^1\]: See chapter 2\.$/m);
		assert.doesNotMatch(text, /----/, "separator notes are skipped");
		assert.match(text, /Attached pictures, in order: \[image 1\]\./);
		assert.equal(images.length, 1);
		assert.equal(images[0]!.mimeType, "image/png");
	});

	it(`attaches at most ${MAX_DOCUMENT_IMAGES} pictures per read and says how to fetch the rest`, async () => {
		const count = MAX_DOCUMENT_IMAGES + 2;
		const relItems: [string, string][] = Array.from({ length: count }, (_, i) => [`rId${i + 1}`, `media/p${i + 1}.png`]);
		const media = Object.fromEntries(Array.from({ length: count }, (_, i) => [`word/media/p${i + 1}.png`, png()]));
		const file = save("many.docx", docx(Array.from({ length: count }, (_, i) => `<w:p>${picture(`rId${i + 1}`)}</w:p>`).join(""), media, relItems));
		const { text, images } = await read({ path: file });
		assert.equal(images.length, MAX_DOCUMENT_IMAGES);
		assert.match(text, /2 more picture\(s\) on this page were not attached/);
		assert.ok(text.includes(`read("${file}!/word/media/p9.png")`), "the follow-up path uses the agent's own path");
		const follow = await read({ path: `${file}!/word/media/p9.png` });
		assert.equal(follow.images.length, 1, "the media entry reads as an ordinary image");
	});

	it("pages long documents like text and only attaches pictures shown on the page", async () => {
		const body = Array.from({ length: 2500 }, (_, i) => wp(`line ${i + 1}`)).join("") + `<w:p>${picture("rId5")}</w:p>`;
		const file = save("long.docx", docx(body));
		const firstPage = await read({ path: file });
		assert.match(firstPage.text, /Use offset=\d+ to continue/);
		assert.equal(firstPage.images.length, 0);
		let page = firstPage, pages = 1;
		while (/Use offset=(\d+)/.test(page.text)) {
			page = await read({ path: file, offset: Number(/Use offset=(\d+)/.exec(page.text)![1]) });
			pages++;
			if (!/\[image 1\]/.test(page.text)) assert.equal(page.images.length, 0, "no picture on pages that don't show it");
		}
		assert.ok(pages > 1);
		assert.match(page.text, /\[image 1\]/);
		assert.equal(page.images.length, 1, "the last page carries the picture");
	});

	it("notes pictures in formats the model can't take, and the model's image support", async () => {
		const file = save("emf.docx", docx(`<w:p>${picture("rId5")}</w:p>`, { "word/media/image1.emf": new Uint8Array([1, 0, 0, 0]) }, [["rId5", "media/image1.emf"]]));
		assert.match((await read({ path: file })).text, /\[image 1\] \(word\/media\/image1\.emf\) is in a format that can't be shown/);
		const textOnly = createReadTool({ input: ["text"] } as never);
		assert.match((await read({ path: save("pic.docx", docx(`<w:p>${picture("rId5")}</w:p>`)) }, textOnly)).text, /does not support images/);
	});
});

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const shape = (type: string | null, paragraphs: [string, number?][]) => `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs.map(([text, lvl]) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:t>${text}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;

describe("read — PowerPoint (.pptx)", () => {
	it("lists slides in presentation order with titles, bullets, tables, pictures and notes", async () => {
		const file = save("deck.pptx", zip({
			"ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
			"ppt/_rels/presentation.xml.rels": rels([["rId2", "slides/slide1.xml", "x/slide"], ["rId3", "slides/slide2.xml", "x/slide"]]),
			"ppt/slides/slide2.xml": `<p:sld ${P}><p:cSld><p:spTree>${shape("title", [["Eigenvalues"]])}${shape("body", [["Av = λv"], ["v ≠ 0", 1]])}<p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>λ</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
			"ppt/slides/_rels/slide2.xml.rels": rels([["rId9", "../media/image1.png"], ["rId10", "../notesSlides/notesSlide1.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"]]),
			"ppt/notesSlides/notesSlide1.xml": `<p:notes ${P}><p:cSld><p:spTree>${shape("sldImg", [])}${shape("body", [["Ask for an example first."]])}</p:spTree></p:cSld></p:notes>`,
			"ppt/slides/slide1.xml": `<p:sld ${P}><p:cSld><p:spTree>${shape("ctrTitle", [["Recap"]])}${shape(null, [["Plain text box"]])}</p:spTree></p:cSld></p:sld>`,
			"ppt/media/image1.png": png(),
		}));
		const { text, images } = await read({ path: file });
		assert.match(text, /^\[PowerPoint presentation, 1 picture\]/);
		assert.ok(text.indexOf("## Slide 1 — Eigenvalues") < text.indexOf("## Slide 2 — Recap"), "presentation order, not file order");
		assert.match(text, /^- Av = λv\n {2}- v ≠ 0$/m);
		assert.match(text, /^\[image 1\]$/m);
		assert.match(text, /^\| λ \|$/m);
		assert.match(text, /^Notes:\nAsk for an example first\.$/m);
		assert.match(text, /^Plain text box$/m);
		assert.equal(images.length, 1);
	});
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

describe("read — Excel (.xlsx)", () => {
	it("renders each sheet as a lettered table with shared/inline strings, booleans, cached formulas and dates", async () => {
		const file = save("grades.xlsx", zip({
			"xl/workbook.xml": `<workbook ${S}><sheets><sheet name="Grades" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>`,
			"xl/_rels/workbook.xml.rels": rels([["rId1", "worksheets/sheet1.xml", "x/worksheet"], ["rId2", "worksheets/sheet2.xml", "x/worksheet"]]),
			"xl/sharedStrings.xml": `<sst ${S}><si><t>Name</t></si><si><r><t>Ana</t></r><r><t> Silva</t></r></si></sst>`,
			"xl/styles.xml": `<styleSheet ${S}><numFmts><numFmt numFmtId="164" formatCode="&quot;Due &quot;yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="2"/></cellXfs></styleSheet>`,
			"xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData>
				<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Passed</t></is></c></row>
				<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" s="1"><v>45000</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" s="3"><f>B3/2</f><v>22500.5</v></c><c r="E3" s="2"><v>45001</v></c></row>
			</sheetData></worksheet>`,
			"xl/worksheets/sheet2.xml": `<worksheet ${S}><sheetData/></worksheet>`,
		}));
		const { text } = await read({ path: file });
		assert.match(text, /^\[Excel workbook\]/);
		assert.match(text, /^## Sheet: Grades$/m);
		assert.match(text, /^\| {2}\| A \| B \| C \| D \| E \|$/m);
		assert.match(text, /^\| 1 \| Name \| {2}\| Passed \| {2}\| {2}\|$/m);
		assert.match(text, /^\| 3 \| Ana Silva \| 2023-03-15 \| TRUE \| 22500\.5 \| 2023-03-16 \|$/m);
		assert.match(text, /^## Sheet: Empty\n\n\(empty sheet\)$/m);
	});

	it("converts Excel serial dates, including the 1904 system and times", () => {
		assert.equal(serialDate(45000), "2023-03-15");
		assert.equal(serialDate(45000.5), "2023-03-15 12:00:00");
		assert.equal(serialDate(0, true), "1904-01-01");
	});
});

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';
const odf = (mimetype: string, body: string, extra: Record<string, Uint8Array> = {}) => zip({
	mimetype,
	"content.xml": `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body>${body}</office:body></office:document-content>`,
	...extra,
});

describe("read — OpenDocument (.odt/.ods/.odp)", () => {
	it("reads text documents: headings, spacing, lists, tables, notes and pictures", async () => {
		const file = save("notes.odt", odf("application/vnd.oasis.opendocument.text", `<office:text>
			<text:h text:outline-level="2">Vectors</text:h>
			<text:p>A<text:s text:c="2"/>vector<text:note><text:note-body><text:p>Also called a tuple.</text:p></text:note-body></text:note> has <text:span>direction</text:span>.</text:p>
			<text:list><text:list-item><text:p>magnitude</text:p><text:list><text:list-item><text:p>norm</text:p></text:list-item></text:list></text:list-item></text:list>
			<table:table><table:table-row><table:table-cell><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"/></table:table-row></table:table>
			<text:p><draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>
		</office:text>`, { "Pictures/a.png": png() }));
		const { text, images } = await read({ path: file });
		assert.match(text, /^\[OpenDocument text, 1 picture\]/);
		assert.match(text, /^## Vectors$/m);
		assert.match(text, /^A {2}vector\[\^1\] has direction\.$/m);
		assert.match(text, /^- magnitude\n {2}- norm$/m);
		assert.match(text, /^\| x \|$/m, "repeated empty columns are trimmed");
		assert.match(text, /^\[\^1\]: Also called a tuple\.$/m);
		assert.equal(images.length, 1);
	});

	it("reads spreadsheets with repeated cells expanded and trailing empties dropped", async () => {
		const file = save("data.ods", odf("application/vnd.oasis.opendocument.spreadsheet", `<office:spreadsheet><table:table table:name="Data">
			<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>b</text:p></table:table-cell></table:table-row>
			<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
		</table:table></office:spreadsheet>`));
		const { text } = await read({ path: file });
		assert.match(text, /^## Sheet: Data$/m);
		assert.match(text, /^\| {2}\| A \| B \| C \|\n\| --- \| --- \| --- \| --- \|\n\| 1 \| a \| b \| b \|$/m);
		assert.ok(text.length < 500, "a million empty rows never materialize");
	});

	it("reads presentations: slide titles, text in order, notes", async () => {
		const file = save("talk.odp", odf("application/vnd.oasis.opendocument.presentation", `<office:presentation>
			<draw:page draw:name="p1">
				<draw:frame presentation:class="title"><draw:text-box><text:p>Bases</text:p></draw:text-box></draw:frame>
				<draw:frame presentation:class="outline"><draw:text-box><text:p>Intro line</text:p><text:list><text:list-item><text:p>spanning</text:p></text:list-item></text:list></draw:text-box></draw:frame>
				<presentation:notes><draw:frame presentation:class="notes"><draw:text-box><text:p>Draw R² first.</text:p></draw:text-box></draw:frame></presentation:notes>
			</draw:page>
		</office:presentation>`));
		const { text } = await read({ path: file });
		assert.match(text, /^## Slide 1 — Bases$/m);
		assert.match(text, /^Intro line\n- spanning$/m);
		assert.match(text, /^Notes:\nDraw R² first\.$/m);
	});
});

describe("read — .zip archives and <file>!/<entry> paths", () => {
	const inner = docx(wp("Inside the archive"));
	const archive = zip({ "week1/notes.docx": inner, "week1/readme.txt": "hello from zip", "data/": new Uint8Array(), "nested.zip": zip({ "deep.txt": "deep text" }) });

	it("lists the entries with sizes and how to read one", async () => {
		const file = save("course.zip", archive);
		const { text } = await read({ path: file });
		assert.match(text, /^\[ZIP archive, 3 files\. Read one with read\("<this path>!\/<entry>"\)/);
		assert.match(text, /^week1\/readme\.txt +14 B$/m);
		assert.doesNotMatch(text, /^data\/$/m, "directories are not listed as files");
	});

	it("reads text, Office documents and nested archives inside it", async () => {
		const file = save("course2.zip", archive);
		assert.equal((await read({ path: `${file}!/week1/readme.txt` })).text, "hello from zip");
		assert.match((await read({ path: `${file}!/week1/notes.docx` })).text, /^Inside the archive$/m);
		assert.equal((await read({ path: `${file}!/nested.zip!/deep.txt` })).text, "deep text");
	});

	it("explains missing entries and non-archives", async () => {
		const file = save("course3.zip", archive);
		await assert.rejects(read({ path: `${file}!/nope.txt` }), /No file "nope\.txt" inside .*course3\.zip/);
		await assert.rejects(read({ path: `${file}!/week1/readme.txt!/x` }), /is not an archive or Office document/);
	});

	it("a real file whose path contains !/ is read literally", async () => {
		const dir = path.join(tmp, "odd!");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "file.txt"), "literal");
		assert.equal((await read({ path: `${dir}/file.txt` })).text, "literal");
	});

	it("refuses encrypted entries and entries over the size limit", async () => {
		const bytes = zip({ "secret.txt": "x", "big.txt": "y" });
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		// Patch the central directory: flag "encrypted" on the first entry, a huge size on the second.
		let at = bytes.length - 22;
		while (view.getUint32(at, true) !== 0x06054b50) at--;
		let entry = view.getUint32(at + 16, true);
		for (let i = 0; i < 2; i++) {
			const name = new TextDecoder().decode(bytes.subarray(entry + 46, entry + 46 + view.getUint16(entry + 28, true)));
			if (name === "secret.txt") view.setUint16(entry + 8, view.getUint16(entry + 8, true) | 1, true);
			if (name === "big.txt") view.setUint32(entry + 24, MAX_ENTRY_BYTES + 1, true);
			entry += 46 + view.getUint16(entry + 28, true) + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
		}
		const entries = listZip(bytes);
		assert.equal(entries.find(e => e.name === "secret.txt")?.encrypted, true);
		assert.throws(() => readZipEntry(bytes, "secret.txt", entries), /encrypted/);
		assert.throws(() => readZipEntry(bytes, "big.txt", entries), /over the 50 MB limit/);
		const file = save("locked.zip", bytes);
		assert.match((await read({ path: file })).text, /secret\.txt +1 B {2}\(encrypted\)/);
		await assert.rejects(read({ path: `${file}!/secret.txt` }), /encrypted/);
	});
});

describe("read — legacy binary Office files", () => {
	const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(504).fill(0)]);
	it("explains .xls/.ppt instead of returning binary noise", async () => {
		await assert.rejects(read({ path: save("old.xls", ole) }), /legacy Microsoft Office file .* save it as \.xlsx, \.pptx or \.docx/);
		await assert.rejects(read({ path: save("old.ppt", ole) }), /legacy Microsoft Office file/);
	});
	it("a .doc that can't be parsed gets the same explanation", async () => {
		await assert.rejects(read({ path: save("broken.doc", ole) }), /legacy Microsoft Office file/);
	});
});

describe("read — unchanged behavior", () => {
	it("plain text and images still read as before", async () => {
		assert.equal((await read({ path: save("plain.txt", strToU8("just text")) })).text, "just text");
		const image = await read({ path: save("pic.png", png()) });
		assert.equal(image.images.length, 1);
		assert.match(image.text, /Read image file \[image\/png\]/);
	});
});
