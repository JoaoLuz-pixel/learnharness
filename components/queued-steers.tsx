/**
 * THE QUEUED-STEER INDICATOR (owner spec 2026-10-03): steers sent but not
 * yet drained render as quiet one-liners ABOVE the composer shell —
 * right-aligned to where the shell's corner rounding starts, truncated
 * with an ellipsis, no background, no container, roughly half opacity.
 * Visible but very quiet; layout tunable later.
 *
 * A line dies the moment its card lands in the transcript: the drain's
 * verbatim message events upsert the real user card by the client-minted
 * id, and visibleQueuedSteers (session-core, pure) filters the queue
 * against the message ids. A steer parked server-side (stranded behind a
 * question) keeps its line — an honest "waiting for the next run".
 */
export interface QueuedSteerLine {
	id: string;
	text: string;
	/** Images riding the steer: tiny thumbnails after the text (owner). */
	images?: readonly { data: string; mimeType: string }[];
}

/** The pure body (SSR-pinnable): one right-aligned truncated line per
 *  queued steer, stacked. */
export function QueuedSteersBody({ steers }: { steers: QueuedSteerLine[] }) {
	if (steers.length === 0) return null;
	return (
		<div className="flex flex-col items-end gap-0.5 pb-1 pr-4" data-testid="queued-steers">
			{steers.map((s) => s.images?.length ? (
				<span key={s.id} className="flex max-w-[240px] items-center gap-1 font-ui text-[11px] text-muted-foreground/60">
					{s.text && <span title={s.text} className="block min-w-0 truncate">{s.text}</span>}
					{s.images.map((image, index) => (
						// Local steer bytes, tiny and quiet like the line itself.
						// eslint-disable-next-line @next/next/no-img-element
						<img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="" aria-hidden draggable={false}
							data-testid="queued-steer-image" className="size-3.5 shrink-0 rounded-[2px] object-cover opacity-80" />
					))}
				</span>
			) : (
				<span
					key={s.id}
					title={s.text}
					className="block max-w-[240px] truncate font-ui text-[11px] text-muted-foreground/60"
				>
					{s.text}
				</span>
			))}
		</div>
	);
}
