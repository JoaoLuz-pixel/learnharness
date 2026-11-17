"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

/**
 * Recent-first session opening (owner, 2026-11-17). Rendering a long
 * history at once took 2–3 s (markdown, math and layout for every message),
 * so a session opens with only its latest messages and the older ones are
 * added in small batches while the page is idle.
 *
 * Why a background fill and not load-on-scroll (owner's choice): Find
 * (Ctrl+F) must search the whole conversation, and filling ahead of time
 * means that work is already done by the time the learner opens Find,
 * instead of a full render at that moment. Every message ends up in the
 * page; nothing is ever unloaded.
 *
 * Budgets count PARTS, not messages: a teacher's consecutive steps are one
 * grouped view message that can hold 1 or 80+ parts (text, quizzes,
 * visuals), so a message count says little about the rendering work.
 */
export const INITIAL_RECENT_PARTS = 40;
/** Roughly 40–50 ms of rendering per batch: below what a keystroke notices. */
export const FILL_BATCH_PARTS = 10;

type Weighted = { parts: readonly unknown[] };
const weight = (message: Weighted | undefined) => Math.max(1, message?.parts.length ?? 1);

/** Walk back from `end` (exclusive) until `budget` parts are covered; at
 *  least one message is always taken. */
function walkBack(messages: readonly Weighted[], end: number, budget: number): number {
	let from = end;
	let covered = 0;
	while (from > 0 && (covered < budget || from === end)) covered += weight(messages[--from]);
	return from;
}

/** The first rendered index. Server and client agree on it (no hash read
 *  here: that would differ between the server render and hydration). */
export function initialRenderFrom(messages: readonly Weighted[]): number {
	return walkBack(messages, messages.length, INITIAL_RECENT_PARTS);
}

/** The next, earlier first index after one fill batch. */
export function nextRenderFrom(messages: readonly Weighted[], from: number): number {
	return walkBack(messages, Math.min(from, messages.length), FILL_BATCH_PARTS);
}

type IdleWindow = typeof globalThis & {
	requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
	cancelIdleCallback?: (handle: number) => void;
};

/**
 * `renderFrom` is the index of the first message to render. It counts from
 * the START of the history, so messages appended during the session are
 * always rendered. `completeNow` renders everything immediately (Find, a
 * link to a specific message).
 */
export function useProgressiveHistory(messages: readonly Weighted[]): { renderFrom: number; completeNow: () => void } {
	const [from, setFrom] = useState(() => initialRenderFrom(messages));
	const renderFrom = Math.min(from, messages.length);
	// Read through a ref: while a turn streams, the list is a new array on
	// every token. Depending on it would cancel the pending idle step each
	// time and stall the fill until the turn ends.
	const messagesRef = useRef(messages);
	useEffect(() => { messagesRef.current = messages; });
	const count = messages.length;

	useEffect(() => {
		if (renderFrom === 0) return;
		const w = globalThis as IdleWindow;
		const step = () => startTransition(() => setFrom((current) => nextRenderFrom(messagesRef.current, current)));
		if (w.requestIdleCallback) {
			const handle = w.requestIdleCallback(step, { timeout: 500 });
			return () => w.cancelIdleCallback?.(handle);
		}
		const timer = setTimeout(step, 16);
		return () => clearTimeout(timer);
	}, [renderFrom, count]);

	const completeNow = useCallback(() => setFrom(0), []);
	return { renderFrom, completeNow };
}
