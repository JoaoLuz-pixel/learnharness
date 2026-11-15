"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeviceSyncStatus, SyncProbeResult } from "@/src/core";
import { useOptionalServerEvent } from "./server-events";

/** Device Sync status for any view: fetched once, refetched on every
 *  `sync-changed` notification (notify-then-fetch, like the other stores). */
export function useDeviceSync() {
	const [status, setStatus] = useState<DeviceSyncStatus | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/sync");
			if (res.ok) setStatus(await res.json() as DeviceSyncStatus);
		} catch { /* the server is restarting: the next notification refetches */ }
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);
	useOptionalServerEvent("sync-changed", () => { void refresh(); });
	/** POST one action; resolves to the new status, rejects with the server's words. */
	const act = useCallback(async <T = DeviceSyncStatus>(action: string, body: Record<string, unknown> = {}): Promise<T> => {
		const res = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
		const value = await res.json().catch(() => ({ error: `Request failed (${res.status})` })) as T & { error?: string };
		if (!res.ok) throw new Error(value.error ?? `Request failed (${res.status})`);
		if (action !== "probe") setStatus(value as unknown as DeviceSyncStatus);
		return value;
	}, []);
	return { status, refresh, act, probe: (host: string, port: number) => act<SyncProbeResult>("probe", { host, port }) };
}

/** Is sync active, so deletions reach every device? (delete warnings). */
export function syncReachesOtherDevices(status: DeviceSyncStatus | null): boolean {
	return !!status?.enabled && !!status.endpoint;
}
