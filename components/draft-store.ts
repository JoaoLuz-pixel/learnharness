import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Unsent composer drafts (text + staged images) that survive a reload, and
 * the opening-image handover from a start screen to its new chat. Local to
 * this device (its device-only folder); nothing here reaches the model until
 * the learner sends. Every operation degrades to "nothing stored": an
 * unreachable or failing store never breaks the composer.
 *
 * Keys: `chat:<id>`, `new:<mode>`, `home:<mode>`, `opening:<id>`.
 */
export interface ComposerDraft {
	text: string;
	images: ImageContent[];
}

/* Stored in the app's device-only folder through /api/device/<key>
 * (owner, 2026-11-16). Browser storage cannot keep them: the desktop
 * page's origin (its port) changes every launch. */
const MAX_DRAFT_BYTES = 25 * 1024 * 1024; // the store's limit, under the API body cap
const url = (key: string) => `/api/device/${encodeURIComponent(key)}`;
async function request(key: string, init?: RequestInit): Promise<Response | null> {
	try { return await fetch(url(key), { cache: "no-store", ...init }); } catch { return null; }
}

/** Structural check on read: stored data is treated as untrusted. */
export function parseComposerDraft(value: unknown): ComposerDraft | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { text, images } = value as { text?: unknown; images?: unknown };
	if (typeof text !== "string" || !Array.isArray(images)) return undefined;
	const valid = images.filter((image): image is ImageContent => !!image && typeof image === "object"
		&& (image as ImageContent).type === "image" && typeof (image as ImageContent).data === "string"
		&& typeof (image as ImageContent).mimeType === "string");
	return { text, images: valid.map(({ type, data, mimeType }) => ({ type, data, mimeType })) };
}

export async function loadDraft(key: string): Promise<ComposerDraft | undefined> {
	const res = await request(key);
	if (!res || res.status !== 200) return undefined;
	try { return parseComposerDraft(await res.json()); } catch { return undefined; }
}

/** An empty draft is a deletion, so sent/cleared drafts leave nothing behind. */
export async function saveDraft(key: string, draft: ComposerDraft): Promise<void> {
	if (!draft.text.trim() && draft.images.length === 0) { await deleteDraft(key); return; }
	const value: ComposerDraft = { text: draft.text, images: draft.images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) };
	const body = JSON.stringify(value);
	// Too large to keep: never let an OLDER saved copy come back instead.
	if (body.length > MAX_DRAFT_BYTES) { await deleteDraft(key); return; }
	await request(key, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
}

export async function deleteDraft(key: string): Promise<void> {
	await request(key, { method: "DELETE" });
}

const pendingSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; draft: ComposerDraft }>();
/** Coalesce keystroke-rate saves; the last draft for a key wins. */
export function scheduleDraftSave(key: string, draft: ComposerDraft, delay = 300): void {
	const pending = pendingSaves.get(key);
	if (pending) clearTimeout(pending.timer);
	const timer = setTimeout(() => { pendingSaves.delete(key); void saveDraft(key, draft); }, delay);
	pendingSaves.set(key, { timer, draft });
}
/** Drop a scheduled save, then delete: a send must not be undone by a late save. */
export function discardDraft(key: string): Promise<void> {
	const pending = pendingSaves.get(key);
	if (pending) { clearTimeout(pending.timer); pendingSaves.delete(key); }
	return deleteDraft(key);
}

export const chatDraftKey = (chatId: string) => `chat:${chatId}`;
export const startDraftKey = (surface: "new" | "home", mode: "teach" | "practice") => `${surface}:${mode}`;

/* The opening-image handover: memory first (same-tab router.push), with a
 * device-folder copy so a reload or restart mid-handover still has them. */
const openingImages = new Map<string, ImageContent[]>();
const openingKey = (chatId: string) => `opening:${chatId}`;

export async function stashOpeningImages(chatId: string, images: readonly ImageContent[]): Promise<void> {
	if (images.length === 0) { clearOpeningImages(chatId); return; }
	const copy = images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
	openingImages.set(chatId, copy);
	await saveDraft(openingKey(chatId), { text: "", images: copy });
}

export async function readOpeningImages(chatId: string): Promise<ImageContent[]> {
	const memory = openingImages.get(chatId);
	if (memory) return memory.map(image => ({ ...image }));
	return (await loadDraft(openingKey(chatId)))?.images ?? [];
}

export function clearOpeningImages(chatId: string): void {
	openingImages.delete(chatId);
	void deleteDraft(openingKey(chatId));
}

/** A deleted chat leaves no stored draft or handover behind. */
export function forgetChatDrafts(chatId: string): void {
	void discardDraft(chatDraftKey(chatId));
	clearOpeningImages(chatId);
}
