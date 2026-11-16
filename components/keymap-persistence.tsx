"use client";

import { useEffect } from "react";
import { KEYMAP_CHANGED_EVENT, loadOverrides, saveOverrides, type KeymapOverrides } from "@/src/core";

/**
 * Keyboard overrides that survive restarts (owner, 2026-11-16). The key map
 * still reads localStorage synchronously, but the desktop page's origin (its
 * port) changes every launch, so localStorage starts empty each time. The
 * device folder (/api/device/keymap) is the durable copy: hydrate on start,
 * then mirror every change. Renders nothing.
 */
export function KeymapPersistence() {
	useEffect(() => {
		let hydrated = false;
		let live = true;
		const persist = () => {
			if (!hydrated) return; // never overwrite the durable copy before reading it
			void fetch("/api/device/keymap", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(loadOverrides()) }).catch(() => undefined);
		};
		window.addEventListener(KEYMAP_CHANGED_EVENT, persist);
		void (async () => {
			try {
				const res = await fetch("/api/device/keymap", { cache: "no-store" });
				if (!live) return;
				const stored = res.status === 200 ? await res.json() as KeymapOverrides : null;
				const local = loadOverrides();
				if (stored && typeof stored === "object" && JSON.stringify(stored) !== JSON.stringify(local)) {
					// The durable copy wins at start; saveOverrides notifies the key map.
					hydrated = true;
					saveOverrides(stored);
					return;
				}
				hydrated = true;
				// Nothing saved yet but overrides exist this launch: keep them.
				if (!stored && Object.keys(local).length) persist();
			} catch { hydrated = true; }
		})();
		return () => { live = false; window.removeEventListener(KEYMAP_CHANGED_EVENT, persist); };
	}, []);
	return null;
}
