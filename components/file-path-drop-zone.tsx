"use client";

import { useEffect, useRef, useState } from "react";
import { FileSymlinkIcon, XIcon } from "lucide-react";
import { directoryReferencePath, quoteFilePath } from "@/src/core";
import { appendToPrimaryInput } from "@/components/dictation";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { imageFilesOf } from "@/components/composer-images";

export function dropLabel(desktop: boolean, inChat: boolean): string {
	if (inChat) return desktop ? "Drop to attach images or file paths" : "Drop to attach images";
	return desktop ? "Drop to attach file paths" : BROWSER_NOTICE;
}

export const BROWSER_NOTICE = "Local file paths can only be attached in the desktop app. You can paste a full path instead.";

/* The in-chat image target: an open chat's composer claims it while
 * mounted; dropped image files then go inline there instead of becoming
 * path chips. Identity-guarded so a remount never clears a newer claim. */
let imageDropTarget: ((files: File[]) => void) | null = null;
export function useImageDropTarget(target: ((files: File[]) => void) | undefined) {
	const latest = useRef(target);
	useEffect(() => { latest.current = target; }, [target]);
	const enabled = target !== undefined;
	useEffect(() => {
		if (!enabled) return;
		const claim = (files: File[]) => latest.current?.(files);
		imageDropTarget = claim;
		return () => { if (imageDropTarget === claim) imageDropTarget = null; };
	}, [enabled]);
}
/** Test seam / drop routing: the current in-chat image target, if any. */
export function currentImageDropTarget() { return imageDropTarget; }

/** The content area only: the sidebar is deliberately outside this zone.
 * Existing files stay where they are; only quoted path strings enter drafts. */
export function FilePathDropZone({ children, className, onContentRoot }: {
	children: React.ReactNode;
	className?: string;
	onContentRoot?: (element: HTMLElement | null) => void;
}) {
	const root = useRef<HTMLElement>(null);
	useEffect(() => {
		onContentRoot?.(root.current);
		return () => { onContentRoot?.(null); };
	}, [onContentRoot]);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [notice, setNotice] = useState("");
	const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
	const clearDrag = () => { depth.current = 0; setDragging(false); };
	useEffect(() => {
		// The sidebar remains a non-target, but dropping a file there must not
		// navigate the app away. No indicator or attachment is produced there.
		const preventOutsideNavigation = (event: DragEvent) => {
			if (Array.from(event.dataTransfer?.types ?? []).includes("Files")
				&& event.target instanceof Node && !root.current?.contains(event.target)) event.preventDefault();
		};
		window.addEventListener("dragover", preventOutsideNavigation);
		window.addEventListener("drop", preventOutsideNavigation);
		return () => {
			window.removeEventListener("dragover", preventOutsideNavigation);
			window.removeEventListener("drop", preventOutsideNavigation);
		};
	}, []);
	return (
		<main
			ref={root}
			className={className}
			data-testid="file-path-drop-zone"
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				depth.current++;
				setDragging(true);
				setNotice("");
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDragging(false);
			}}
			onDragEnd={clearDrag}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				// A nested target (the reading box) already took this drop.
				const claimed = event.defaultPrevented;
				event.preventDefault();
				event.stopPropagation();
				clearDrag();
				if (claimed) { setNotice(""); return; }
				const dropped = Array.from(event.dataTransfer.files);
				// In an open chat, image files go inline (owner); everything else
				// keeps the path behavior. Unsupported images get the composer's
				// notice there and never fall back to a path chip.
				const inline = imageDropTarget;
				const images = inline ? new Set(imageFilesOf(dropped)) : new Set<File>();
				if (inline && images.size) inline([...images]);
				if (images.size > 0 && images.size === dropped.length) { setNotice(""); return; }
				const resolve = window.lh?.getPathForFile;
				if (!resolve) { setNotice(BROWSER_NOTICE); return; }
				// Inspect only the dropped item's type, never traverse its entries.
				// Positively known directories get a durable trailing separator.
				const entries = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
				const paths: string[] = [];
				let skipped = 0;
				for (const [index, file] of dropped.entries()) {
					if (images.has(file)) continue;
					try {
						let directory = false;
						try { directory = entries[index]?.webkitGetAsEntry?.()?.isDirectory === true; }
						catch { /* Unknown type stays unmarked, not guessed. */ }
						const original = resolve(file);
						const path = directory ? directoryReferencePath(original) : original;
						quoteFilePath(path); // Same rooted-path validity rule as typed chips.
						paths.push(path);
					} catch { skipped++; }
				}
				if (paths.length === 0) {
					setNotice("No local file paths were available. Drop existing files or folders from your computer.");
					return;
				}
				const focused = document.activeElement?.closest<HTMLElement>("[data-file-path-input]");
				if (focused && event.currentTarget.contains(focused)) {
					focused.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
				} else if (!appendToPrimaryInput(paths.map(quoteFilePath).join(" "))) {
					setNotice("Open a chat to attach file paths.");
					return;
				}
				setNotice(skipped ? "Some dropped items had no available file path." : "");
			}}
		>
			{children}
			{dragging && (
				<div data-testid="file-path-drop-indicator" className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85 p-6 text-center backdrop-blur-sm">
					<div className="flex max-w-md flex-col items-center gap-3">
						<FileSymlinkIcon className="size-8 text-primary" aria-hidden />
						<span className="font-ui text-sm">{dropLabel(Boolean(window.lh?.getPathForFile), imageDropTarget !== null)}</span>
					</div>
				</div>
			)}
			{notice && <div role="status" className="absolute bottom-2 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border bg-card px-3 py-2 font-ui text-xs shadow-sm">
				<span>{notice}</span>
				<button type="button" aria-label="Dismiss attachment notice" onClick={() => setNotice("")} className="shrink-0 rounded-sm p-1 hover:bg-accent"><XIcon className="size-3" aria-hidden /></button>
			</div>}
		</main>
	);
}
