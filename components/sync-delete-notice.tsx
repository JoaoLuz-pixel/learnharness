"use client";

import { useState } from "react";
import { syncReachesOtherDevices, useDeviceSync } from "@/components/use-device-sync";

/** Deleting while Device Sync is on reaches EVERY synced device (owner,
 *  2026-11-15: delete everywhere, with an extra explicit approval). */
export interface SyncDeleteGate { approved: boolean; onApproved: (next: boolean) => void }

export function useSyncDeleteGate(): { gate: SyncDeleteGate | undefined; reset: () => void } {
	const { status } = useDeviceSync();
	const [approved, setApproved] = useState(false);
	return { gate: syncReachesOtherDevices(status) ? { approved, onApproved: setApproved } : undefined, reset: () => setApproved(false) };
}

export function SyncDeleteNotice({ gate, disabled, what }: { gate: SyncDeleteGate; disabled?: boolean; what: string }) {
	return <label data-testid="sync-delete-notice" className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-warning/50 bg-warning/5 px-4 py-3">
		<input type="checkbox" data-testid="sync-delete-approve" checked={gate.approved} disabled={disabled}
			onChange={(e) => gate.onApproved(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" />
		<span className="min-w-0">
			<span className="block text-sm text-foreground">Also delete {what} on all my synced devices</span>
			<span className="mt-1 block text-xs text-muted-foreground">Device Sync is on: this deletion reaches every device connected to your endpoint the next time it syncs.</span>
		</span>
	</label>;
}
