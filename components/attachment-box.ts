"use client";

import type { DragEvent, RefObject } from "react";
import { INSERT_FILE_PATHS_EVENT } from "./path-input";
import { imageFilesOf } from "./composer-images";
import { BROWSER_NOTICE, UNRESOLVED_PASTE_NOTICE, pastedFilePaths } from "./pasted-files";
import type { StagedImages } from "./staged-images";

/**
 * Attachments for the thinking boxes (fork, 2026-11-25): the "Thinking
 * while reading" box and every "Your thinking" field (question, plugin
 * question and practice docks) take images and documents the same way.
 *
 * - Paste (PathInput): images go to the box's strip, documents become path
 *   chips (PathInput's own pasted-files handling), text is still inserted.
 * - Drop ON the box: the same split, inside this box. The chat-wide drop
 *   zone sees defaultPrevented and only clears its indicator.
 * - `data-attachment-composer` makes the box's paperclip menu open above
 *   the box rather than above the main bar.
 */

/** Props for the box element that wraps the field (drop target). */
export function attachmentBoxProps(editorRef: RefObject<HTMLDivElement | null>, images?: StagedImages) {
	return {
		"data-attachment-composer": "",
		onDragOver: (e: DragEvent<HTMLElement>) => {
			if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
		},
		onDrop: (e: DragEvent<HTMLElement>) => {
			const files = Array.from(e.dataTransfer.files);
			if (!files.length) return; // not files: the usual drop handling applies
			e.preventDefault();
			const resolve = window.lh?.getPathForFile;
			const documents = pastedFilePaths(e.dataTransfer, resolve);
			if (documents.paths.length) editorRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: documents.paths }));
			const notice = documents.unresolved ? (resolve ? UNRESOLVED_PASTE_NOTICE : BROWSER_NOTICE) : "";
			const picked = images ? imageFilesOf(files) : [];
			if (images && picked.length) void images.add(picked, notice);
			else if (notice) images?.setNotice(notice);
		},
	};
}

/** PathInput props that send pasted images (and paste notices) to the box's strip. */
export function pasteAttachmentProps(images?: StagedImages) {
	return {
		onPasteImages: images ? (files: File[], notice?: string) => { void images.add(files, notice); } : undefined,
		onPasteNotice: images?.setNotice,
	};
}
