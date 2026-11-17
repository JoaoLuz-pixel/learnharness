/**
 * Recent-first session opening (owner, 2026-11-17): the latest content
 * renders at once, the rest fills in while idle, and Find or a message link
 * renders the whole history immediately.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { FILL_BATCH_PARTS, INITIAL_RECENT_PARTS, initialRenderFrom, nextRenderFrom, useProgressiveHistory } from "../components/progressive-history.ts";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, Element: window.Element, HTMLElement: window.HTMLElement });

/* A manual idle queue: the test decides when the browser is "idle". */
const idle = new Map<number, () => void>();
let nextHandle = 1;
Object.assign(globalThis, {
	requestIdleCallback: (cb: () => void) => { const h = nextHandle++; idle.set(h, cb); return h; },
	cancelIdleCallback: (h: number) => { idle.delete(h); },
});
async function runIdle() {
	const pending = [...idle.entries()];
	idle.clear();
	await act(async () => { for (const [, cb] of pending) cb(); });
}

type Row = { id: string; parts: unknown[] };
const row = (id: string, parts = 1): Row => ({ id, parts: Array.from({ length: parts }) });
let state: { renderFrom: number; completeNow: () => void } = { renderFrom: -1, completeNow: () => {} };
function Probe({ messages }: { messages: Row[] }) {
	state = useProgressiveHistory(messages);
	return <ul>{messages.slice(state.renderFrom).map((m) => <li key={m.id}>{m.id}</li>)}</ul>;
}
let root: Root | null = null;
const host = document.createElement("div");
async function render(messages: Row[]) {
	if (!root) root = (await import("react-dom/client")).createRoot(host as unknown as HTMLElement);
	await act(async () => { root!.render(<Probe messages={messages} />); });
}
const shown = () => [...host.querySelectorAll("li")].map((li) => li.textContent);
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; idle.clear(); });

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("progressive history", () => {
	it("opens with the latest ~40 parts and fills ~10 parts at a time down to the first", () => {
		assert.equal(INITIAL_RECENT_PARTS, 40);
		assert.equal(FILL_BATCH_PARTS, 10);
		const rows = (...sizes: number[]) => sizes.map((n) => ({ parts: Array.from({ length: n }) }));
		assert.equal(initialRenderFrom([]), 0);
		assert.equal(initialRenderFrom(rows(5, 5, 5)), 0, "short sessions render whole, as before");
		// SYL's tail (owner's real session): grouped teacher rows of very different sizes.
		const syl = rows(1, 16, 2, 3, 2, 2, 2, 57, 1, 8, 1, 84, 2, 30, 2, 16, 2, 80, 1, 7, 1, 5, 2, 2, 8, 1, 5, 2, 5, 2, 8);
		const first = initialRenderFrom(syl);
		assert.equal(first, 21, "the last 10 rows: exactly 40 parts, the 80-part row waits for the fill");
		assert.equal(initialRenderFrom(rows(3, 90)), 1, "the latest message is always rendered, however large");
		const steps: number[] = [];
		for (let from = first; from > 0; from = nextRenderFrom(syl, from)) steps.push(from);
		assert.deepEqual(steps, [21, 17, 15, 13, 11, 8, 7, 2, 1], "then 0: every message is rendered in the end");
		assert.equal(nextRenderFrom(syl, 1), 0);
	});

	it("the chat keeps whole-history indexes, completes on Find and on a message link", () => {
		const chat = source("components/chat.tsx");
		assert.match(chat, /useProgressiveHistory\(messages\)/);
		assert.match(chat, /messages\.slice\(renderFrom\)[^\n]*mi = k \+ renderFrom/, "phases[mi] etc. still index the whole history");
		assert.match(chat, /<SessionFind [^>]*onOpen=\{renderWholeHistory\}/);
		assert.match(chat, /messageIdFromHash\(window\.location\.hash\)\) renderWholeHistory\(\)/);
		assert.match(source("components/session-find.tsx"), /onOpen\?\.\(\);\s*setOpen\(true\)/);
	});

	it("the shell warms the session page at launch", () => {
		assert.match(source("electron/main.cjs"), /fetch\(`\$\{url\}\/chat\/lh-warmup`/);
	});

	it("fills to the very first message, one idle step at a time", async () => {
		const history = Array.from({ length: 12 }, (_, i) => row(`m${i}`, 5));
		await render(history);
		assert.deepEqual(shown(), ["m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11"], "the latest 40 parts");
		let steps = 0;
		while (idle.size && steps < 50) { await runIdle(); steps++; }
		assert.equal(state.renderFrom, 0);
		assert.equal(shown().length, 12, "every message rendered in the end");
		assert.equal(steps, 2);
	});

	it("a streaming turn (a new list on every token) never cancels the pending fill step", async () => {
		const history = Array.from({ length: 12 }, (_, i) => row(`m${i}`, 5));
		await render(history);
		const pending = [...idle.keys()];
		for (let token = 1; token <= 30; token++) {
			// Same messages, the last one growing: what a live turn looks like.
			await render([...history.slice(0, 11), row("m11", 5 + token)]);
		}
		assert.deepEqual([...idle.keys()], pending, "still the same scheduled step");
		await runIdle();
		assert.ok(state.renderFrom < 4, "the fill progressed during the stream");
	});

	it("messages that arrive mid-fill always render; Find completes at once; a shorter list clamps", async () => {
		const history = Array.from({ length: 12 }, (_, i) => row(`m${i}`, 5));
		await render(history);
		await render([...history, row("new1"), row("new2")]);
		assert.deepEqual(shown().slice(-2), ["new1", "new2"]);
		assert.equal(shown()[0], "m4", "the older part is still filling");
		await act(async () => { state.completeNow(); });
		assert.equal(shown().length, 14, "Find / a message link: the whole history, immediately");
		await render(history.slice(0, 3));
		assert.deepEqual(shown(), ["m0", "m1", "m2"]);
	});
});
