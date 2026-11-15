import type { ImageContent } from "@earendil-works/pi-ai";
import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt";
import { clearOpeningImages, stashOpeningImages } from "./draft-store";

/** An image-only opening's session title (owner decision). */
export const IMAGE_ONLY_SESSION_TITLE = "New session";
/** The opening message, when it is not simply the title text. */
export interface SessionOpening {
	text: string;
	images: readonly ImageContent[];
}
/** Title for a start: the text, or the fixed title for image-only. */
export function sessionTitleFor(text: string): string {
	return text.trim() || IMAGE_ONLY_SESSION_TITLE;
}

interface SessionCreation {
	title: string;
	kind?: "practice";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string, opening?: SessionOpening): Promise<string> {
		const text = opening ? opening.text : body.title;
		const images = opening?.images ?? [];
		// Changed images are a different start too (fingerprint, not bytes).
		const identity = JSON.stringify([body, settingsIdentity, ...(opening ? [text, images.map(image => [image.mimeType, image.data.length, image.data.slice(-32)])] : [])]);
		if (this.created?.identity !== identity) {
			if (this.created) { clearOpeningPrompt(this.created.id); clearOpeningImages(this.created.id); }
			this.created = undefined;
			const res = await fetchLike("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(OPENING_PROMPT_FAILURE);
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		// Images first: the text entry's flag promises them to the chat page.
		await stashOpeningImages(this.created.id, images);
		if (!stashOpeningPrompt(this.created.id, text, false, images.length > 0)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}
