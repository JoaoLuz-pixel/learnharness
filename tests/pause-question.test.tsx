/**
 * The reading-thinking pause send (owner, 2026-11-15): the box posts its
 * text NOW — the open question closes with a PAUSED result (adjacent to its
 * call), the learner's message follows, and the teacher decides what next.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { inputAppends, parseChatInput, pauseQuestionAppends } from "../src/core/input-events.ts";
import { danglingQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import { compactAnswerForModel, pausedAnswer } from "../src/core/question-core.ts";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { PAUSE_COPY, PauseQuestionBody, pauseConfirmed } from "../components/pause-question-dialog.tsx";

function pose(calls: { name: string; id: string; question: string }[]): LhMessage {
	return { ...fauxAssistantMessage(calls.map(c => fauxToolCall(c.name, { question: c.question, mode: "text" }, { id: c.id })), { stopReason: "toolUse" }), id: "pose" } as LhMessage;
}

describe("pause-question input", () => {
	it("parses with a target and non-empty text only", () => {
		assert.deepEqual(parseChatInput({ type: "pause-question", toolCallId: "call", text: "wait, what is a basis?" }), { type: "pause-question", toolCallId: "call", text: "wait, what is a basis?" });
		assert.throws(() => parseChatInput({ type: "pause-question", toolCallId: "call", text: "   " }));
		assert.throws(() => parseChatInput({ type: "pause-question", toolCallId: "", text: "x" }));
	});

	it("appends the paused result for exactly that call, then the learner's message", () => {
		const record = { messages: [pose([{ name: "ask_user_question", id: "call", question: "Which is a basis?" }])] };
		const appends = inputAppends(record, { type: "pause-question", toolCallId: "call", text: "What does span mean?" });
		assert.equal(appends.length, 2);
		const [result, message] = appends as [LhMessage & { role: string; toolCallId: string; content: { text: string }[]; details: Record<string, unknown> }, LhMessage & { role: string; content: unknown }];
		assert.equal(result.role, "toolResult");
		assert.equal(result.toolCallId, "call");
		assert.deepEqual(JSON.parse(result.content[0]!.text), { kind: "ask", paused: true }, "the model reads paused, not dismissed");
		assert.equal(result.details.questionText, "Which is a basis?", "built server-side from the call itself");
		assert.equal(result.details.dismissed, true, "still a closed, never-graded call everywhere else");
		assert.equal(message.role, "user");
		assert.equal(message.content, "What does span mean?");
		assert.equal(danglingQuestionOf([...record.messages, ...appends]), null);
	});

	it("refuses a stale target and a pause that would leave a sibling question open", () => {
		const single = { messages: [pose([{ name: "ask_user_question", id: "call", question: "Q" }])] };
		assert.throws(() => pauseQuestionAppends(single, { toolCallId: "other", text: "x" }), /no pending question/);
		assert.throws(() => pauseQuestionAppends({ messages: [] }, { toolCallId: "call", text: "x" }), /no pending question/);
		const parallel = { messages: [pose([{ name: "ask_user_question", id: "one", question: "Q1" }, { name: "ask_user_question", id: "two", question: "Q2" }])] };
		assert.throws(() => pauseQuestionAppends(parallel, { toolCallId: "one", text: "x" }), /other open questions/);
	});

	it("compacts a pause as {kind, paused} and keeps plain dismissals unchanged", () => {
		assert.deepEqual(compactAnswerForModel(pausedAnswer("explain", "Why?")), { kind: "explain", paused: true });
		assert.deepEqual(compactAnswerForModel({ ...pausedAnswer("ask", "Why?"), paused: undefined }), { kind: "ask", dismissed: true });
	});
});

describe("pause presentation", () => {
	it("the transcript card says paused and reveals nothing", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={pausedAnswer("quiz", "Which is a basis?")} />);
		assert.match(html, /Which is a basis\?<\/span> — paused/);
		assert.doesNotMatch(html, /skipped/);
	});

	it("the reading box shows a send button only when it can send, disabled while empty or busy", () => {
		const field = (props: Partial<React.ComponentProps<typeof ReadingThinkingField>>) => renderToStaticMarkup(
			<ReadingThinkingField value="" revision={0} onChange={() => {}} claim={false} {...props} />);
		assert.doesNotMatch(field({}), /reading-thinking-send/, "no send without the capability (plugin questions)");
		assert.match(field({ onSend: () => {} }), /aria-label="Pause question and send"[^>]*disabled=""/, "empty → disabled");
		assert.doesNotMatch(field({ onSend: () => {}, value: "a thought" }), /aria-label="Pause question and send"[^>]*disabled=""/);
		assert.match(field({ onSend: () => {}, value: "a thought", sendDisabled: true }), /aria-label="Pause question and send"[^>]*disabled=""/, "busy → disabled");
	});

	it("the first-time confirmation explains the pause and offers don't-ask-again", () => {
		const html = renderToStaticMarkup(<PauseQuestionBody onClose={() => {}} onConfirm={() => {}} />);
		assert.ok(html.includes(PAUSE_COPY.title));
		assert.match(html, /data-testid="pause-question-remember"/);
		assert.match(html, /Pause and send/);
		assert.equal(pauseConfirmed(), false, "no storage → ask");
	});

	it("the teacher prompt carries the approved paused-questions section", () => {
		const prompt = readFileSync(new URL("../src/agent/prompts/shared/20-question-tools.md", import.meta.url), "utf8");
		assert.match(prompt, /### Paused questions/);
		assert.match(prompt, /never grade it or treat it as a skip/);
	});
});

describe("images in the reading box (owner, 2026-11-15)", () => {
	const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
	const staged = (images: typeof image[]) => ({ images, imagesRef: { current: images }, setImages: () => {}, add: async () => {}, remove: () => {}, clearIfUnchanged: () => {}, notice: "", setNotice: () => {}, dismissNotice: () => {} });

	it("a pause may carry images, with or without text, and they ride the learner's message", () => {
		assert.deepEqual(parseChatInput({ type: "pause-question", toolCallId: "call", text: "", images: [image] }), { type: "pause-question", toolCallId: "call", text: "", images: [image] });
		assert.throws(() => parseChatInput({ type: "pause-question", toolCallId: "call", text: "", images: [] }));
		const record = { messages: [pose([{ name: "ask_user_question", id: "call", question: "Q" }])] };
		const [, message] = pauseQuestionAppends(record, { toolCallId: "call", text: "see this", images: [image] }) as [unknown, { content: unknown }];
		assert.ok(Array.isArray(message.content) && (message.content as { type: string }[]).some(block => block.type === "image"), "the image is native content of the message");
	});

	it("the box shows its thumbnails, and images alone enable the send", () => {
		const html = renderToStaticMarkup(<ReadingThinkingField value="" revision={0} onChange={() => {}} claim={false} onSend={() => {}} images={staged([image])} />);
		assert.match(html, /data-testid="staged-images"/);
		assert.doesNotMatch(html, /aria-label="Pause question and send"[^>]*disabled=""/);
		assert.match(renderToStaticMarkup(<ReadingThinkingField value="" revision={0} onChange={() => {}} claim={false} onSend={() => {}} images={staged([])} />), /aria-label="Pause question and send"[^>]*disabled=""/);
	});
});
