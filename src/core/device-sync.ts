/** DEVICE SYNC — the client-visible contract (owner, 2026-11-15). Types and
 *  constants only: safe to import from browser code. */
export type SyncCategoryToggle = "layout" | "settings" | "plugins" | "promptsThemes";
export type SyncToggleState = Record<SyncCategoryToggle, boolean>;
export const SYNC_INTERVALS = [5, 10, 30, 60] as const;
export type SyncInterval = (typeof SYNC_INTERVALS)[number];

export type SyncPhase =
	| "off"          // no endpoint, or disconnected on purpose
	| "connecting"
	| "syncing"
	| "in-sync"
	| "offline"      // endpoint unreachable: working locally, retrying
	| "blocked";     // the endpoint's identity changed: refuse until checked

export interface SyncConflictView {
	id: string;
	/** What it is, in learner words ("Session “Boolean algebra”", "Graph node “Minterm”"). */
	label: string;
	kind: "session" | "node" | "other";
	deletedOn?: "local" | "remote";
	remoteDevice?: string;
	remoteAt?: string;
	localPreview?: string;
	remotePreview?: string;
	detectedAt: string;
	canKeepBoth: boolean;
}

export interface SyncDeviceView { id: string; name: string; lastSeen: string; self: boolean }
/** One sync on the endpoint, as the chooser lists it (owner, 2026-11-20). */
export interface SyncChoiceView {
	id: string;
	name: string;
	createdAt: string;
	createdBy: string;
	devices: { id: string; name: string; lastSeen: string }[];
}
/** Which sync a device goes to: an existing one, or a new one it names. */
export type SyncTarget = { kind: "join"; id: string } | { kind: "create"; name: string };
export interface SyncLockView { chatId: string; deviceName: string; expiresAt: string }
export interface SetAsideView { id: string; createdAt: string; files: number }

export interface DeviceSyncStatus {
	phase: SyncPhase;
	deviceId: string;
	deviceName: string;
	publicKey: string | null;
	endpoint: { host: string; port: number; fingerprint: string } | null;
	/** The sync this device belongs to on that endpoint (several may exist). */
	sync: { id: string; name: string } | null;
	/** The learner wants sync on (Disconnect clears it; the key stays). */
	enabled: boolean;
	toggles: SyncToggleState;
	intervalSec: SyncInterval;
	lastSyncAt: string | null;
	lastError: string | null;
	conflicts: SyncConflictView[];
	devices: SyncDeviceView[];
	/** Sessions running a turn on ANOTHER device right now. */
	locks: SyncLockView[];
	setAside: SetAsideView[];
}

/** First contact with an endpoint, before anything is trusted or written. */
export interface SyncProbeResult {
	fingerprint: string;
	/** Every sync on the endpoint; empty = this device creates the first one. */
	syncs: SyncChoiceView[];
}

export type JoinChoice = "merge" | "set-aside";
export type ConflictDecision = "local" | "remote" | "both";
