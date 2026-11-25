/**
 * Images and files in every "Your thinking" box (fork, 2026-11-25): the
 * built-in question dock (select modes only), the plugin question dock (when
 * it shows thinking) and the practice dock take paste, drop and a paperclip
 * left of Submit — the same as the "Thinking while reading" box, through the
 * shared helper components/attachment-box.ts. Free-text "Your answer" is
 * unchanged. chat.tsx sends the staged images on each submission's existing
 * thinking image channel.
 */
import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { attachmentBoxProps, pasteAttachmentProps } from "../components/attachment-box.ts";
import { BROWSER_NOTICE, UNRESOLVED_PASTE_NOTICE } from "../components/pasted-files.ts";
import type { StagedImages } from "../components/staged-images.tsx";

const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

type Added = { files: File[]; notice?: string };
function staged(images: typeof image[] = []) {
	const added: Added[] = [];
	const notices: string[] = [];
	const value = {
		images, imagesRef: { current: images }, setImages() {}, remove() {}, clearIfUnchanged() {}, dismissNotice() {}, notice: "",
		add: async (files: File[], notice?: string) => { added.push({ files, notice }); },
		setNotice: (notice: string) => { notices.push(notice); },
	} as unknown as StagedImages;
	return { value, added, notices };
}
const documentOf = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;

const selectQuestion = { question: "Which is a basis?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A spans." };
const textQuestion = { question: "Explain the result", correctAnswer: "Reference answer" };

describe('"Your thinking" in built-in questions', () => {
	it("a select question's thinking box takes drops, shows staged images, and has the paperclip just left of Submit", () => {
		const doc = documentOf(<QuestionDock toolName="probe" toolCallId="q1" input={selectQuestion} expanded dictationClaim={false}
			onExpand={() => {}} onSubmit={() => {}} thinkingImages={staged([image]).value} />);
		const field = doc.querySelector('[data-testid="thinking-field"]')!;
		assert.ok(field);
		assert.equal(field.getAttribute("data-attachment-composer"), "", "its paperclip menu opens above this box");
		assert.ok(field.querySelector('[data-testid="staged-images"]'), "staged images show in the box");
		const submit = [...field.querySelectorAll("button")].find((b) => b.textContent === "Submit answer")!;
		const group = submit.parentElement!;
		assert.ok(group.classList.contains("ml-auto"));
		assert.ok(group.firstElementChild?.querySelector('[data-testid="attach-files"]'), "paperclip first in the Submit group");
		assert.equal(group.lastElementChild, submit);
	});

	it('a free-text question\'s "Your answer" box stays as it was: no paperclip, no image strip, no box drop', () => {
		const doc = documentOf(<QuestionDock toolName="explain" toolCallId="q2" input={textQuestion} expanded dictationClaim={false}
			onExpand={() => {}} onSubmit={() => {}} thinkingImages={staged([image]).value} />);
		const field = doc.querySelector('[data-testid="answer-field"]')!;
		assert.ok(field, "free-text mode renders Your answer");
		assert.equal(field.getAttribute("data-attachment-composer"), null);
		assert.equal(field.querySelector('[data-testid="staged-images"]'), null);
		assert.equal(field.querySelector('[data-testid="attach-files"]'), null);
	});
});

describe('"Your thinking" in practice', () => {
	const render = (images: typeof image[]) => documentOf(<PracticeDock problemCallId="p1" input={{ statement: "Prove it." }} expanded
		onExpand={() => {}} onSubmit={() => {}} onPrepareSubmission={() => {}} images={staged(images).value} />);

	it("takes drops, shows staged images and has the paperclip just left of Submit thinking", () => {
		const doc = render([image]);
		const field = doc.querySelector('[data-testid="practice-thinking-field"]')!;
		assert.equal(field.getAttribute("data-attachment-composer"), "");
		assert.ok(field.querySelector('[data-testid="staged-images"]'));
		const send = field.querySelector('[data-testid="practice-send"]')!;
		assert.ok(send.parentElement?.firstElementChild?.querySelector('[data-testid="attach-files"]'));
		assert.equal(send.parentElement?.lastElementChild, send);
	});

	it("Submit thinking is enabled by images alone, and still disabled when empty", () => {
		assert.equal(render([]).querySelector('[data-testid="practice-send"]')!.hasAttribute("disabled"), true);
		assert.equal(render([image]).querySelector('[data-testid="practice-send"]')!.hasAttribute("disabled"), false);
	});
});

describe("the shared attachment helper", () => {
	const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
	const pdf = () => new File(["%PDF"], "notes.pdf", { type: "application/pdf" });
	const g = globalThis as unknown as { window?: unknown };
	const previous = g.window;
	afterEach(() => { g.window = previous; });

	function drop(files: File[], images?: StagedImages) {
		const inserted: unknown[] = [];
		const editorRef = { current: { dispatchEvent: (event: CustomEvent) => { inserted.push(event.detail); return true; } } } as unknown as React.RefObject<HTMLDivElement | null>;
		let prevented = false;
		attachmentBoxProps(editorRef, images).onDrop({
			dataTransfer: { files, items: files.map(() => ({ kind: "file" })), types: ["Files"], getData: () => "" },
			preventDefault: () => { prevented = true; },
		} as unknown as React.DragEvent<HTMLElement>);
		return { inserted, prevented };
	}

	it("a drop sends images to the strip and documents into this box as path chips (desktop)", () => {
		g.window = { lh: { getPathForFile: (file: File) => `/docs/${file.name}` } };
		const images = staged();
		const shot = png();
		const { inserted, prevented } = drop([shot, pdf()], images.value);
		assert.equal(prevented, true, "the chat-wide drop zone does not also handle it");
		assert.deepEqual(inserted, [["/docs/notes.pdf"]]);
		assert.deepEqual(images.added, [{ files: [shot], notice: "" }]);
	});

	it("in a browser, documents explain themselves; a desktop item without a path is reported", () => {
		g.window = {};
		const images = staged();
		assert.deepEqual(drop([pdf()], images.value).inserted, []);
		assert.deepEqual(images.notices, [BROWSER_NOTICE]);
		g.window = { lh: { getPathForFile: () => "" } };
		const desktop = staged();
		drop([pdf()], desktop.value);
		assert.deepEqual(desktop.notices, [UNRESOLVED_PASTE_NOTICE]);
	});

	it("paste props route images (with any notice) to the strip; no images prop means no image paste", () => {
		const images = staged();
		const props = pasteAttachmentProps(images.value);
		const shot = png();
		props.onPasteImages!([shot], "note");
		assert.deepEqual(images.added, [{ files: [shot], notice: "note" }]);
		assert.equal(typeof props.onPasteNotice, "function");
		const none = pasteAttachmentProps(undefined);
		assert.equal(none.onPasteImages, undefined);
		assert.equal(none.onPasteNotice, undefined);
	});
});

describe("chat.tsx sends the staged thinking images", () => {
	const chat = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");

	it("each submission path fills its thinking image channel from the staged images", () => {
		assert.match(chat, /thinking: \{ text: raw\.thinking \?\? "", images: questionThinkingImages\.imagesRef\.current\.map/, "built-in answers");
		assert.match(chat, /images: original\.showThinking \? questionThinkingImages\.imagesRef\.current\.map/, "plugin answers, only when the plugin shows thinking");
		assert.match(chat, /type: "thinking", content: \{ text: captured = capture\(\), images: \(capturedImages = problemThinkingImages\.imagesRef\.current\.map/, "practice thinking");
		assert.match(chat, /type: "plugin-problem-submission", submission: raw\.submission, submissionImages: \[\], thinking: \{ text: raw\.thinking \?\? "", images: capturedImages\.map/, "plugin practice");
		assert.equal((chat.match(/problemThinkingImages\.clearIfUnchanged\(capturedImages\)/g) ?? []).length, 2, "practice images clear once the submission is accepted");
	});

	it("the images reset when the question or problem changes, and reach every dock", () => {
		assert.match(chat, /thinkingImagesQuestion\.current = pendingQuestionId;\s*setQuestionThinkingImages\(\[\], false\);/);
		assert.match(chat, /thinkingImagesProblem\.current = activeProblemKey;\s*setProblemThinkingImages\(\[\], false\);/);
		assert.match(chat, /<PluginQuestionDock[^>]*thinkingImages=\{questionThinkingImages\}/);
		assert.match(chat, /thinkingImages=\{questionThinkingImages\}\s*dictationClaim/, "built-in question dock");
		assert.match(chat, /images=\{problemThinkingImages\}/, "practice dock");
		assert.match(chat, /thinkingImages: problemThinkingImages,/, "plugin practice dock");
	});
});
