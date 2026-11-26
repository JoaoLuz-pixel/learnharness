"use client";

/**
 * CHEAT SHEET (owner, 2026-11-26): a session's own markdown sheet, built
 * from the teacher's answers ("+" / "Add to cheat sheet") and edited by
 * hand. It replaces the session view; "Back to session" returns. Rendered
 * like the chat's messages; Edit switches to plain markdown (autosaved).
 * Exports: PDF (light, desktop app), Word, Markdown, plain text.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, NotebookPen } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { cheatSheetFileName } from "@/src/core";

type SaveState = "saved" | "saving" | "unsaved" | "error";
const EXPORTS = [
	{ id: "pdf", label: "PDF" },
	{ id: "docx", label: "Word (.docx)" },
	{ id: "md", label: "Markdown (.md)" },
	{ id: "txt", label: "Plain text (.txt)" },
] as const;

export function CheatSheet({ chatId, title }: { chatId: string; title: string }) {
	const router = useRouter();
	const api = `/api/chats/${encodeURIComponent(chatId)}/cheatsheet`;
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [save, setSave] = useState<SaveState>("saved");
	const [error, setError] = useState("");
	const [exportOpen, setExportOpen] = useState(false);
	const [notice, setNotice] = useState("");
	const latest = useRef("");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let live = true;
		fetch(api, { cache: "no-store" }).then(async res => {
			const body = await res.json() as { markdown?: string; error?: string };
			if (!res.ok) throw new Error(body.error ?? `Could not open the cheat sheet (${res.status})`);
			if (live) { latest.current = body.markdown ?? ""; setMarkdown(body.markdown ?? ""); }
		}).catch(err => { if (live) setError((err as Error).message); });
		return () => { live = false; };
	}, [api]);

	const flush = useCallback(async () => {
		if (timer.current) { clearTimeout(timer.current); timer.current = null; }
		setSave("saving");
		try {
			const res = await fetch(api, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: latest.current }) });
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Save failed (${res.status})`);
			setSave("saved"); setError("");
		} catch (err) { setSave("error"); setError((err as Error).message); }
	}, [api]);
	// Leaving with unsaved edits still saves them.
	useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void fetch(api, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: latest.current }), keepalive: true }); } }, [api]);

	const edit = (next: string) => {
		latest.current = next; setMarkdown(next); setSave("unsaved");
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => void flush(), 800);
	};

	const exportAs = async (format: (typeof EXPORTS)[number]["id"]) => {
		setExportOpen(false); setNotice("");
		if (save !== "saved") await flush();
		if (format !== "pdf") { window.location.href = `${api}?export=${format}`; return; }
		const html = await (await fetch(`${api}?export=html`, { cache: "no-store" })).text();
		if (window.lh?.saveCheatSheetPdf) {
			try {
				const result = await window.lh.saveCheatSheetPdf(html, cheatSheetFileName(title, "pdf"));
				if (result.saved) setNotice(`Saved ${result.path ?? "the PDF"}`);
			} catch (err) { setError((err as Error).message); }
			return;
		}
		// Browser: print the same light page ("Save as PDF" in the print dialog).
		const win = window.open("", "_blank");
		if (!win) { setError("Allow pop-ups to export a PDF."); return; }
		win.document.open(); win.document.write(html); win.document.close();
		win.focus(); win.print();
	};

	// Switching Edit/view keeps your place: the same relative position in the
	// sheet, since the rendered and plain heights differ.
	const scrollRef = useRef<HTMLDivElement>(null);
	const place = useRef<number | null>(null);
	const keepPlace = () => {
		const el = scrollRef.current;
		if (!el) return;
		const room = el.scrollHeight - el.clientHeight;
		place.current = room > 0 ? el.scrollTop / room : 0;
	};
	useLayoutEffect(() => {
		const el = scrollRef.current, ratio = place.current;
		if (!el || ratio === null) return;
		place.current = null;
		el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
	}, [editing]);

	const saveLabel = save === "saving" ? "Saving…" : save === "unsaved" ? "Unsaved" : save === "error" ? "Not saved" : "Saved";
	// The same frame as a session (owner, 2026-11-26): exactly one screen
	// high, so only the sheet scrolls; the sidebar and top bar stay put.
	return <div data-testid="cheat-sheet" className="flex h-dvh"><div className="flex min-w-0 flex-1 flex-col">
		<TopBar>
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<NotebookPen aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
				<h1 className="min-w-0 truncate font-title text-2xl tracking-tight">{title} <span className="text-muted-foreground">· Cheat sheet</span></h1>
			</div>
			<div className="lh-no-drag flex shrink-0 items-center gap-2">
				{markdown !== null && <span data-testid="cheat-sheet-save" className="font-ui text-xs text-muted-foreground">{saveLabel}</span>}
				<Button type="button" variant="outline" size="sm" data-testid="cheat-sheet-back" onClick={() => router.push(`/chat/${encodeURIComponent(chatId)}`)}>
					<ArrowLeft aria-hidden="true" className="size-3.5" />Back to session
				</Button>
				<Button type="button" variant={editing ? "default" : "outline"} size="sm" data-testid="cheat-sheet-edit" disabled={markdown === null}
					onClick={() => { if (editing) void flush(); keepPlace(); setEditing(!editing); }}>{editing ? "Done" : "Edit"}</Button>
				<div className="relative">
					<Button type="button" variant="outline" size="sm" data-testid="cheat-sheet-export" disabled={!markdown?.trim()} aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>
						<Download aria-hidden="true" className="size-3.5" />Export
					</Button>
					{exportOpen && <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border bg-popover p-1 shadow-md">
						{EXPORTS.map(item => <button key={item.id} type="button" role="menuitem" data-testid={`cheat-sheet-export-${item.id}`}
							className="block w-full rounded-sm px-2 py-1.5 text-left font-ui text-xs hover:bg-accent" onClick={() => void exportAs(item.id)}>{item.label}</button>)}
					</div>}
				</div>
			</div>
		</TopBar>
		{(error || notice) && <p role={error ? "alert" : "status"} className={`lh-transcript-column mx-auto w-full px-6 pt-3 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || notice}</p>}
		<div ref={scrollRef} data-cheat-sheet-scroll="" className="min-h-0 flex-1 overflow-y-auto">
			<div className="lh-transcript-column mx-auto w-full px-6 py-6">
				{markdown === null ? (!error && <p className="text-sm text-muted-foreground">Opening…</p>)
					: editing ? <MarkdownSource value={markdown} onChange={edit} />
					: markdown.trim() ? <div data-testid="cheat-sheet-view"><MessageResponse>{markdown}</MessageResponse></div>
						: <div data-testid="cheat-sheet-empty" className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
							This cheat sheet is empty. Add a teacher answer with the <strong>+</strong> next to it in the session, or select part of an answer and choose <strong>Add to cheat sheet</strong>. You can also click <strong>Edit</strong> and write your own.
						</div>}
			</div>
		</div>
	</div></div>;
}

/** Edit mode (owner, 2026-11-26): the same page and column, no box: only
 *  the text turns into its plain markdown. Grows with its content, so the
 *  page scrolls exactly like the rendered view. */
function MarkdownSource({ value, onChange }: { value: string; onChange: (next: string) => void }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	// Re-fit to the text WITHOUT moving the page (owner, 2026-11-26): the
	// wrapper holds the old height while the box re-measures, and the
	// scroll position is put back in the same frame.
	useLayoutEffect(() => {
		const el = ref.current, holder = el?.parentElement;
		if (!el || !holder) return;
		const scroller = holder.closest<HTMLElement>("[data-cheat-sheet-scroll]");
		const top = scroller?.scrollTop ?? 0;
		holder.style.minHeight = `${el.offsetHeight}px`;
		el.style.height = "0px";
		el.style.height = `${el.scrollHeight}px`;
		holder.style.minHeight = "";
		if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
	}, [value]);
	return <div><textarea ref={ref} data-testid="cheat-sheet-editor" aria-label="Cheat sheet markdown" value={value} spellCheck={false}
		onChange={e => onChange(e.currentTarget.value)}
		className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-prose text-(length:--lh-prose-size) leading-relaxed text-foreground outline-none" /></div>;
}
