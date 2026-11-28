/** DEVICE SYNC — the client-visible contract (owner, 2026-11-15). Types and
 *  constants only: safe to import from browser code. */
export type SyncCategoryToggle = "layout" | "settings" | "plugins" | "promptsThemes" | "cheatsheets";
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
/** One sync on the endpoint, as the chooser lists it (owner, 2026-11-20).
 *  A password-protected sync this device is not in shows only its name and
 *  a lock (owner, 2026-11-28): no creator, dates or devices. */
export interface SyncChoiceView {
	id: string;
	name: string;
	locked?: boolean;
	createdAt?: string;
	createdBy?: string;
	devices?: { id: string; name: string; lastSeen: string }[];
}
/** Which sync a device goes to: an existing one, or a new one it names.
 *  `password`: joining a protected sync, or protecting a new one. */
export type SyncTarget = { kind: "join"; id: string; password?: string } | { kind: "create"; name: string; password?: string };

/** Where this device syncs (owner, 2026-11-28):
 *  ssh    — an SSH endpoint (the original kind);
 *  host   — another device's built-in host, over the network or Tailscale;
 *  folder — a cloud folder (OneDrive, iCloud Drive…) the provider's app copies;
 *  self   — the built-in host on this very device. */
export type SyncEndpointView =
	| { kind: "ssh" | "host"; host: string; port: number; fingerprint: string }
	| { kind: "folder"; path: string }
	| { kind: "self" };
/** What Connect is pointed at, before anything is trusted. */
export type SyncEndpointTarget =
	| { kind: "address"; host: string; port: number }
	| { kind: "folder"; path: string }
	| { kind: "self" };

/** The built-in host on this device ("Host sync on this device"). */
export interface SyncHostView {
	enabled: boolean;
	running: boolean;
	port: number;
	fingerprint: string;
	/** Tailscale first, then local network addresses. */
	addresses: { kind: "tailscale" | "lan"; address: string }[];
	syncs: { id: string; name: string; members: number }[];
	error: string | null;
}
export interface CloudFolderSuggestionView { provider: string; path: string }
export interface SyncLockView { chatId: string; deviceName: string; expiresAt: string }
export interface SetAsideView { id: string; createdAt: string; files: number }

export interface DeviceSyncStatus {
	phase: SyncPhase;
	deviceId: string;
	deviceName: string;
	publicKey: string | null;
	endpoint: SyncEndpointView | null;
	/** The sync this device belongs to on that endpoint (several may exist). */
	sync: { id: string; name: string; locked: boolean } | null;
	host: SyncHostView;
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
	/** What answered: an SSH endpoint, a built-in host, or a folder. */
	kind: "ssh" | "host" | "folder" | "self";
	/** SSH endpoints and hosts; absent for folders and this device. */
	fingerprint?: string;
	/** Can a device create a sync there? (Not on another device's host.) */
	canCreate: boolean;
	/** Must a new sync there have a password? (The built-in host.) */
	passwordRequired: boolean;
	/** Every sync on the endpoint; empty = this device creates the first one. */
	syncs: SyncChoiceView[];
}

export type JoinChoice = "merge" | "set-aside";
export type ConflictDecision = "local" | "remote" | "both";
