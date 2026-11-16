"use client";

import { useCallback, useRef, useState } from "react";
import type { ImageContent } from "@earendil-works/pi-ai";
import { XIcon } from "lucide-react";
import { admitComposerImages } from "./composer-images";
import { useSessionMermaid } from "./session-overlay";

/**
 * Images staged in a composer but not yet sent. The ref mirror is what
 * sends read (like the composer's textRef), so a send never captures a
 * stale render. `onChange` lets the owner persist the draft.
 */
export function useStagedImages(onChange?: (images: ImageContent[]) => void) {
	const [images, setState] = useState<ImageContent[]>([]);
	const imagesRef = useRef<ImageContent[]>([]);
	const [notice, setNotice] = useState("");
	const changed = useRef(onChange);
	changed.current = onChange;
	const setImages = useCallback((next: ImageContent[], notify = true) => {
		imagesRef.current = next;
		setState(next);
		if (notify) changed.current?.(next);
	}, []);
	/** `alsoNotice`: a notice from the same paste/drop (e.g. a document
	 *  without a path) — set together so admission never erases it. */
	const add = useCallback(async (files: File[], alsoNotice = "") => {
		const admitted = await admitComposerImages(files);
		if (admitted.images.length) setImages([...imagesRef.current, ...admitted.images]);
		setNotice([admitted.notice, alsoNotice].filter(Boolean).join(" "));
	}, [setImages]);
	const remove = useCallback((index: number) => {
		setImages(imagesRef.current.filter((_, i) => i !== index));
	}, [setImages]);
	/** Clear only if the staged set is still the one that was sent. */
	const clearIfUnchanged = useCallback((sent: readonly ImageContent[]) => {
		const current = imagesRef.current;
		if (current.length === sent.length && current.every((image, i) => image.data === sent[i]?.data)) setImages([]);
	}, [setImages]);
	const dismissNotice = useCallback(() => setNotice(""), []);
	return { images, imagesRef, setImages, add, remove, clearIfUnchanged, notice, setNotice, dismissNotice };
}

export type StagedImages = ReturnType<typeof useStagedImages>;

const thumb = "size-14";

/** The composer's thumbnail row: × removes, a click opens the fullscreen
 *  viewer where the session provides one. */
export function StagedImageStrip({ images, onRemove, notice, onDismissNotice }: {
	images: readonly ImageContent[];
	onRemove: (index: number) => void;
	notice?: string;
	onDismissNotice?: () => void;
}) {
	const viewer = useSessionMermaid();
	if (!images.length && !notice) return null;
	return <div className="flex basis-full flex-col gap-1.5 px-1 pt-1" data-testid="staged-images">
		{images.length > 0 && <ul className="flex flex-wrap gap-2" aria-label="Attached images">
			{images.map((image, index) => {
				const src = `data:${image.mimeType};base64,${image.data}`;
				// Local staged bytes: no remote optimization applies.
				// eslint-disable-next-line @next/next/no-img-element
				const preview = <img src={src} alt={`Attached image ${index + 1}`} draggable={false} className={`${thumb} rounded-md border object-cover`} />;
				return <li key={`${index}:${image.data.length}:${image.data.slice(-16)}`} className="relative">
					{viewer?.openImage ? <button type="button" className="block cursor-zoom-in rounded-md" aria-label={`Open attached image ${index + 1}`}
						onClick={(event) => {
							const element = event.currentTarget.querySelector("img");
							if (element?.naturalWidth && element.naturalHeight) viewer.openImage?.({ src, width: element.naturalWidth, height: element.naturalHeight });
						}}>{preview}</button> : preview}
					<button type="button" aria-label={`Remove attached image ${index + 1}`} data-testid="remove-staged-image"
						onClick={() => onRemove(index)}
						className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground">
						<XIcon className="size-3" aria-hidden />
					</button>
				</li>;
			})}
		</ul>}
		{notice && <div role="status" className="flex items-center gap-2 font-ui text-xs text-muted-foreground">
			<span>{notice}</span>
			{onDismissNotice && <button type="button" aria-label="Dismiss image notice" onClick={onDismissNotice} className="rounded-sm p-0.5 hover:bg-accent"><XIcon className="size-3" aria-hidden /></button>}
		</div>}
	</div>;
}
