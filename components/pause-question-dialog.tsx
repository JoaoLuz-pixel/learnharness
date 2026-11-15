"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import { HostDialog } from "@/components/host-dialog";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";

/**
 * The first-time pause confirmation (owner, 2026-11-15): sending from the
 * "Thinking while reading" box PAUSES the open question — it closes
 * unanswered and the teacher replies to the message instead. Shown until
 * the learner ticks "Don't ask again" (remembered on this device only).
 */
export const PAUSE_CONFIRMED_KEY = "lh.pauseQuestion.confirmed";

export const PAUSE_COPY = {
	title: "Pause this question and send?",
	line: "The question closes without an answer. The teacher replies to your message and decides what comes next, which may be asking it again.",
	remember: "Don't ask again",
	action: "Pause and send",
};

/** Storage can throw or be empty (private windows, blocked site data). */
export function pauseConfirmed(): boolean {
	try { return globalThis.localStorage?.getItem(PAUSE_CONFIRMED_KEY) === "true"; } catch { return false; }
}
export function rememberPauseConfirmed(): void {
	try { globalThis.localStorage?.setItem(PAUSE_CONFIRMED_KEY, "true"); } catch { /* asked again next time */ }
}

export function PauseQuestionBody({ onClose, onConfirm, renderFrame }: {
	onClose: () => void;
	onConfirm: (remember: boolean) => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const [remember, setRemember] = useState(false);
	const frame = (
		<div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
			<h2 className="text-sm font-semibold text-card-foreground" data-testid="pause-question-title">{PAUSE_COPY.title}</h2>
			<p className="mt-1.5 text-xs text-muted-foreground">{PAUSE_COPY.line}</p>
			<label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
				<input type="checkbox" data-testid="pause-question-remember" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
				{PAUSE_COPY.remember}
			</label>
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" data-testid="pause-question-cancel" onClick={onClose}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
				<button type="button" data-testid="pause-question-confirm" onClick={() => onConfirm(remember)}
					className="rounded-sm border bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:opacity-90">{PAUSE_COPY.action}</button>
			</div>
		</div>
	);
	if (renderFrame) return renderFrame(frame);
	return <div role="dialog" aria-modal="true" aria-label={PAUSE_COPY.title} data-testid="pause-question-dialog"
		className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" {...backdropDismiss}>{frame}</div>;
}

export function PauseQuestionDialog({ open, onClose, onConfirm }: {
	open: boolean;
	onClose: () => void;
	onConfirm: (remember: boolean) => void;
}) {
	if (!open) return null;
	return <PauseQuestionBody onClose={onClose} onConfirm={onConfirm}
		renderFrame={(frame) => <HostDialog open frame={frame} aria-label={PAUSE_COPY.title}
			onClose={() => { onClose(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm", "data-testid": "pause-question-dialog" }}>
			{frame.props.children}
		</HostDialog>} />;
}
