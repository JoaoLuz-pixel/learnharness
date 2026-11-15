"use client";

import { CloudIcon, CloudOffIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";
import type { DeviceSyncStatus } from "@/src/core";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";

/** Pure view (SSR-pinnable): the sidebar's Device Sync icon + conflict
 *  badge. Hidden until an endpoint exists (owner, 2026-11-15). */
export function SyncIndicatorView({ status, onOpen }: { status: DeviceSyncStatus | null; onOpen: () => void }) {
	if (!status?.endpoint) return null;
	const conflicts = status.conflicts.length;
	const { Icon, tone, label } = conflicts > 0
		? { Icon: CloudIcon, tone: "text-warning", label: `${conflicts} sync conflict${conflicts === 1 ? "" : "s"} to resolve` }
		: status.phase === "syncing" || status.phase === "connecting" ? { Icon: RefreshCwIcon, tone: "text-muted-foreground animate-spin", label: "Syncing…" }
		: status.phase === "in-sync" ? { Icon: CloudIcon, tone: "text-success", label: "In sync" }
		: status.phase === "blocked" ? { Icon: ShieldAlertIcon, tone: "text-destructive", label: "Sync blocked: the endpoint's identity changed" }
		: { Icon: CloudOffIcon, tone: "text-muted-foreground", label: status.enabled ? "Offline: working locally" : "Sync paused" };
	return <Hint label={label} side="right">
		<button type="button" aria-label={`Device Sync: ${label}`} data-testid="sync-indicator" data-phase={status.phase} onClick={onOpen}
			className="relative flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent">
			<Icon className={cn("size-3.5", tone)} />
			{conflicts > 0 && <span data-testid="sync-conflict-badge" className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-semibold leading-3.5 text-background">{conflicts}</span>}
		</button>
	</Hint>;
}
