/**
 * CHEAT SHEETS (owner, 2026-11-26): one markdown document per session that
 * the learner builds from the teacher's answers ("+" on an answer, or "Add to
 * cheat sheet" on a selection) and edits by hand. Pure helpers, browser-safe.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";

/** The most a cheat sheet may hold (UTF-8 bytes). */
export const MAX_CHEATSHEET_BYTES = 2 * 1024 * 1024;
/** Between two additions. */
export const CHEATSHEET_SEPARATOR = "\n\n---\n\n";

/** Append one addition: blank content stays as is; additions are divided. */
export function appendToCheatSheet(current: string, addition: string): string {
	const piece = addition.trim();
	if (!piece) return current;
	const body = current.replace(/\s+$/, "");
	return body ? `${body}${CHEATSHEET_SEPARATOR}${piece}\n` : `${piece}\n`;
}

/** A plain-text version (.txt export): the words, without markdown symbols,
 *  one block per paragraph; code blocks keep their code. */
export function cheatSheetPlainText(markdown: string): string {
	const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	const blocks: string[] = [];
	const visit = (node: { type: string; value?: string; children?: unknown[] }, indent = ""): void => {
		switch (node.type) {
			case "code": blocks.push(node.value ?? ""); return;
			case "thematicBreak": blocks.push("----------"); return;
			case "list":
				for (const item of (node.children ?? []) as { children?: unknown[] }[]) {
					blocks.push(`${indent}- ${toString(item as never).replace(/\n+/g, " ").trim()}`);
				}
				return;
			case "table":
				for (const row of (node.children ?? []) as { children?: unknown[] }[]) {
					blocks.push(((row.children ?? []) as never[]).map(cell => toString(cell).trim()).join("\t"));
				}
				return;
			case "root": case "blockquote":
				for (const child of (node.children ?? []) as never[]) visit(child, indent);
				return;
			default: {
				const text = toString(node as never).trim();
				if (text) blocks.push(text);
			}
		}
	};
	visit(tree as never);
	return `${blocks.join("\n\n")}\n`;
}

/** A safe file name for exports: "<session title> - cheat sheet.<ext>". */
export function cheatSheetFileName(title: string, ext: "pdf" | "docx" | "md" | "txt"): string {
	const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Session";
	return `${base} - cheat sheet.${ext}`;
}
