import * as fs from "node:fs/promises";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { detectSupportedImageMimeType, processImage } from "../image-processing/index.ts";
import { looksLikeZip, readDocument, readZipEntry, ZipError, type ReadableDocument } from "./documents/index.ts";

/**
 * The read tool — sources v0 (2026-09): a Node port of pi's read semantics
 * for the learner's local files. The flow is learner-owned: he pastes file
 * paths into the chat, the agent reads on its own terms (nothing is
 * auto-injected). Broad local reads remain the scope, except the shared
 * sensitive-location/credential denials and optional folder boundary in fs-shared.ts; this is not a sandbox.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/read.js):
 * - text files: utf-8, offset (1-indexed) / limit slicing, and the
 *   2000-line / 50KB truncation ceiling with actionable "use offset=N"
 *   continuation notices — a huge file never silently floods the context.
 * - image files (jpg/png/gif/webp/bmp): returned as native image content
 *   parts so the vision-capable model actually SEES them (teacher's
 *   glm-5.3-flash accepts image input per pi's zai catalog; tool-execute's
 *   toToolResult maps ImageFileResult to pi's ImageContent).
 * - unreadable/missing files throw — pi turns that into an error tool
 *   result the model sees and recovers from.
 *
 * Usage guidance ships in the description (the self-contained-tools
 * principle, user-decided 2026-09: system prompts reference only
 * always-on tools — read IS always-on, but its doctrine still lives here).
 */

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
/** Embedded pictures sent with one page of a document (owner plan). */
export const MAX_DOCUMENT_IMAGES = 8;
/** Separates an archive from a path inside it: `course.zip!/week1/notes.docx`. */
const ENTRY_SEPARATOR = "!/";

const readInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Slice + truncate the text body, pi's continuation-notice style. */
function readTextSlice(text: string, offset: number | undefined, limit: number | undefined): string {
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
	}
	// honor an explicit limit first (never beyond EOF)
	let selected = allLines.slice(startLine, limit !== undefined ? startLine + limit : totalLines);
	// then the 2000-line ceiling
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > MAX_LINES) {
		selected = selected.slice(0, MAX_LINES);
		truncatedBy = "lines";
	}
	// then the 50KB ceiling
	if (Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
		while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_BYTES) {
			selected.pop();
		}
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) {
		const remaining = totalLines - (startLine + selected.length);
		if (remaining > 0) {
			return `${selected.join("\n")}\n\n[${remaining} more lines in file. Use offset=${startLine + selected.length + 1} to continue.]`;
		}
		return selected.join("\n");
	}
	const endLineDisplay = startLine + selected.length;
	const reason =
		truncatedBy === "lines" ? `${MAX_LINES} line limit` : `${formatSize(MAX_BYTES)} limit`;
	return `${selected.join("\n")}\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${totalLines} (${reason}). Use offset=${endLineDisplay + 1} to continue.]`;
}

/**
 * The read tool, shared verbatim by the prober and the teacher. Sources v1
 * (2026-09-19): the description is pi-verbatim (user: copy tool usage
 * guidance exactly) — the teaching doctrine moved to the shared prompt
 * fragment (prompts/shared/). Relative paths resolve against the
 * learner's home (fs-shared.ts), the harness's anchor.
 */
export type ReadModel = Pick<Model<Api>, "input" | "inputLimits">;

/** One implementation for every learner-file reader. Bind the active model
 * per agent, rather than sharing mutable model state between conversations.
 * Home-relative paths, text slicing and the app's abort guard stay unchanged;
 * image detection/processing and its notes follow native Pi read behavior. */
export function createReadTool(model?: ReadModel): AgentTool<typeof readInput> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. Also reads documents as Markdown-like text: Word (.docx, .doc), PowerPoint (.pptx), Excel (.xlsx) and OpenDocument (.odt, .ods, .odp); their embedded pictures appear as [image N] and are attached for the page you read (up to ${MAX_DOCUMENT_IMAGES}). A .zip returns its file list; read an entry inside an archive or document with "<file>!/<entry>", e.g. "course.zip!/week1/notes.docx" or "slides.pptx!/ppt/media/image3.png". For text files and documents, output is truncated to 2000 lines or 50.0KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. File access settings and protected-location denials apply; use ls without a path to discover allowed folders when restricted.`,
		parameters: readInput,
		execute: serverExecute("read", readInput, async ({ path: rawPath, offset, limit }, { signal }): Promise<string | ImageFileResult> => {
			const { bytes: buffer, name } = await loadTarget(rawPath, signal);
			const mime = detectSupportedImageMimeType(buffer);
			if (mime) {
				const processed = await processImage(buffer, mime, { resizeOptions: model?.inputLimits?.images?.resize });
				signal?.throwIfAborted();
				const note = processed.ok
					? [`Read image file [${processed.mimeType}]`, ...processed.hints]
					: [`Read image file [${mime}]`, processed.message];
				if (model && !model.input.includes("image")) {
					note.push("[Current model does not support images. The image will be omitted from this request.]");
				}
				return {
					text: note.join("\n"),
					...(processed.ok ? { images: [{ data: processed.data, mimeType: processed.mimeType }] } : {}),
				};
			}
			let document: ReadableDocument | null;
			try { document = await readDocument(buffer, name); }
			catch (error) { throw new Error(error instanceof ZipError ? error.message : `Could not read ${name}: ${(error as Error).message}`); }
			signal?.throwIfAborted();
			if (document) return documentPage(document, rawPath, offset, limit, model, signal);
			return readTextSlice(buffer.toString("utf-8"), offset, limit);
		}),
	};
}

export const readTool = createReadTool();

/**
 * The bytes to read: a file, or an entry inside an archive/document named
 * with "!/" (nested allowed). A real file whose name contains "!/" wins.
 * File access rules apply to the outer file.
 */
async function loadTarget(rawPath: string, signal?: AbortSignal): Promise<{ bytes: Buffer; name: string }> {
	if (rawPath.includes(ENTRY_SEPARATOR)) {
		const literal = resolveSourcePath(rawPath);
		const stat = await fs.stat(literal).catch(() => null);
		if (stat?.isFile()) return { bytes: await fs.readFile(literal, { signal }), name: literal };
		const [outer, ...inner] = rawPath.split(ENTRY_SEPARATOR);
		let bytes: Buffer = await fs.readFile(resolveSourcePath(outer), { signal });
		let name = outer!;
		for (const entry of inner) {
			if (!looksLikeZip(bytes)) throw new Error(`${name} is not an archive or Office document, so "${entry}" can't be read inside it.`);
			const data = readZipEntry(bytes, entry);
			if (!data) throw new Error(`No file "${entry}" inside ${name}. Read ${name} itself to list what it contains.`);
			bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			name = entry;
		}
		return { bytes, name };
	}
	const absolute = resolveSourcePath(rawPath);
	return { bytes: await fs.readFile(absolute, { signal }), name: absolute };
}

/** One page of a document's text, with the pictures whose placeholders it shows. */
async function documentPage(document: ReadableDocument, rawPath: string, offset: number | undefined, limit: number | undefined, model: ReadModel | undefined, signal?: AbortSignal): Promise<string | ImageFileResult> {
	const page = readTextSlice(document.text, offset, limit);
	const shown = [...new Set([...page.matchAll(/\[image (\d+)\]/g)].map(match => Number(match[1])))].filter(n => document.images.has(n));
	if (!shown.length || !document.container) return page;
	const notes: string[] = [];
	const images: { data: string; mimeType: string }[] = [];
	const attached: number[] = [];
	const entryPath = (n: number) => `${rawPath}${ENTRY_SEPARATOR}${document.images.get(n)}`;
	for (const n of shown.slice(0, MAX_DOCUMENT_IMAGES)) {
		let bytes: Uint8Array | null = null;
		try { bytes = readZipEntry(document.container, document.images.get(n)!); } catch { /* reported below */ }
		const mime = bytes ? detectSupportedImageMimeType(bytes) : null;
		if (!bytes || !mime) { notes.push(`[image ${n}] (${document.images.get(n)}) is in a format that can't be shown (e.g. EMF/WMF/SVG/TIFF).`); continue; }
		const processed = await processImage(bytes, mime, { resizeOptions: model?.inputLimits?.images?.resize });
		signal?.throwIfAborted();
		if (!processed.ok) { notes.push(`[image ${n}]: ${processed.message}`); continue; }
		images.push({ data: processed.data, mimeType: processed.mimeType });
		attached.push(n);
	}
	if (attached.length) notes.unshift(`Attached pictures, in order: ${attached.map(n => `[image ${n}]`).join(", ")}.`);
	const rest = shown.slice(MAX_DOCUMENT_IMAGES);
	if (rest.length) notes.push(`${rest.length} more picture(s) on this page were not attached (limit ${MAX_DOCUMENT_IMAGES} per read). Read one with read("${entryPath(rest[0]!)}"); the others: ${rest.map(n => `[image ${n}] = ${document.images.get(n)}`).join(", ")}.`);
	if (images.length && model && !model.input.includes("image")) notes.push("[Current model does not support images. The pictures will be omitted from this request.]");
	const text = `${page}\n\n${notes.join("\n")}`;
	return images.length ? { text, images } : text;
}
