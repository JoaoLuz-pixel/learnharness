import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { imageFilesOf } from "./composer-images";

/**
 * PASTED DOCUMENTS (owner, 2026-11-16): a pasted non-image file becomes a
 * path chip, exactly like the paperclip or a drop — the file stays where it
 * is and the agent reads it from disk. Desktop only: a browser File has no
 * local path.
 *
 * The Linux workaround (owner-approved): file managers there usually copy a
 * file as `file://` addresses (text/uri-list, or GNOME's
 * "x-special/nautilus-clipboard" text), so Chromium hands the paste no File.
 * Such addresses become chips too. They come from clipboard text, so the
 * file's existence is not verified — the same as a typed path.
 */

export const BROWSER_NOTICE = "Local file paths can only be attached in the desktop app. You can paste a full path instead.";
export const UNRESOLVED_PASTE_NOTICE = "Some pasted items had no available file path.";

type ClipboardLike = {
	files?: ArrayLike<File> | Iterable<File> | null;
	items?: ArrayLike<{ kind?: string; webkitGetAsEntry?: () => { isDirectory?: boolean } | null }> | null;
	getData?: (type: string) => string;
};

/** One `file://` URI → a rooted path (a host becomes a UNC share), or null. */
export function fileUriToPath(uri: string): string | null {
	let url: URL;
	try { url = new URL(uri.trim()); } catch { return null; }
	if (url.protocol !== "file:") return null;
	let path: string;
	try { path = decodeURIComponent(url.pathname); } catch { return null; }
	if (url.hostname && url.hostname !== "localhost") {
		// file://server/share/x → a UNC path (Windows network share).
		path = `\\\\${url.hostname}${path.replace(/\//g, "\\")}`;
	} else if (/^\/[a-z]:[\\/]/i.test(path)) {
		path = path.slice(1).replace(/\//g, "\\"); // file:///C:/x → C:\x
	}
	try { quoteFilePath(path); } catch { return null; }
	return path;
}

/**
 * Clipboard text that is ONLY file addresses → their paths; anything else
 * (ordinary text, a web link, a single non-file line) → null, so the text is
 * pasted as text. Accepts text/uri-list (with `#` comments) and GNOME's
 * "x-special/nautilus-clipboard\ncopy|cut\n<uris>" form.
 */
export function fileUrisToPaths(text: string): string[] | null {
	let lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
	if (lines[0] === "x-special/nautilus-clipboard") lines = lines.slice(1);
	if (lines[0] === "copy" || lines[0] === "cut") lines = lines.slice(1);
	if (!lines.length) return null;
	const paths: string[] = [];
	for (const line of lines) {
		const path = fileUriToPath(line);
		if (path === null) return null;
		paths.push(path);
	}
	return paths;
}

export type PastedFiles = {
	/** Rooted paths to chip, in clipboard order. */
	paths: string[];
	/** The paste carried non-image files that could not become paths. */
	unresolved: boolean;
	/** The paths came from clipboard text: that text must not also be pasted. */
	fromText: boolean;
};

/** Non-image files (via the desktop bridge) or, failing that, file:// text. */
export function pastedFilePaths(data: ClipboardLike | null | undefined, resolve: ((file: File) => string) | undefined): PastedFiles {
	const all = Array.from((data?.files ?? []) as Iterable<File>);
	const images = new Set(imageFilesOf(all));
	const items = Array.from(data?.items ?? []).filter(item => item.kind === "file");
	const paths: string[] = [];
	let unresolved = false;
	for (const [index, file] of all.entries()) {
		if (images.has(file)) continue;
		if (!resolve) { unresolved = true; continue; }
		try {
			let directory = false;
			try { directory = items[index]?.webkitGetAsEntry?.()?.isDirectory === true; } catch { /* a file */ }
			const path = resolve(file);
			paths.push(directory ? directoryReferencePath(path) : (quoteFilePath(path), path));
		} catch { unresolved = true; }
	}
	if (paths.length || unresolved || all.length || !resolve) return { paths, unresolved, fromText: false };
	const uris = fileUrisToPaths(data?.getData?.("text/uri-list") ?? "") ?? fileUrisToPaths(data?.getData?.("text/plain") ?? "");
	return uris ? { paths: uris, unresolved: false, fromText: true } : { paths: [], unresolved: false, fromText: false };
}
