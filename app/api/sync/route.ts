// Device Sync (owner design 2026-11-15): GET the status; POST one action.
// Loopback-only like every route (the desktop server binds 127.0.0.1).
import { deviceSync } from "@/src/server";
import type { ConflictDecision, JoinChoice, SyncTarget } from "@/src/core";

const HOST = /^[A-Za-z0-9.:\-[\]]{1,255}$/;

function endpointOf(body: Record<string, unknown>): { host: string; port: number } {
	const host = typeof body.host === "string" ? body.host.trim() : "";
	const port = body.port === undefined || body.port === "" ? 22 : Number(body.port);
	if (!HOST.test(host)) throw new Error("Enter the endpoint's host name or IP address");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port must be a number from 1 to 65535");
	return { host, port };
}

/** Join an existing sync (by id) or create one (with a name). */
function targetOf(value: unknown): SyncTarget {
	const t = value as { kind?: unknown; id?: unknown; name?: unknown } | null;
	if (t?.kind === "join" && typeof t.id === "string" && t.id.length <= 40) return { kind: "join", id: t.id };
	if (t?.kind === "create" && typeof t.name === "string") return { kind: "create", name: t.name };
	throw new Error("Choose a sync to join, or create one");
}
const joinOf = (value: unknown): JoinChoice | undefined => value === "merge" || value === "set-aside" ? value : undefined;

export async function GET() {
	return Response.json(deviceSync().status());
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.action !== "string") return Response.json({ error: "Missing action" }, { status: 400 });
	const sync = deviceSync();
	try {
		switch (body.action) {
			case "generate-key":
				sync.generateKey(); break;
			case "configure":
				sync.configure({
					...(typeof body.deviceName === "string" ? { deviceName: body.deviceName } : {}),
					...(body.toggles && typeof body.toggles === "object" ? { toggles: body.toggles as Record<string, boolean> } : {}),
					...(body.intervalSec !== undefined ? { intervalSec: Number(body.intervalSec) } : {}),
				});
				break;
			case "probe":
				return Response.json(await sync.probe(endpointOf(body).host, endpointOf(body).port));
			case "connect": {
				const { host, port } = endpointOf(body);
				if (typeof body.fingerprint !== "string" || !body.fingerprint.startsWith("SHA256:")) throw new Error("Confirm the endpoint's fingerprint first");
				const join = joinOf(body.join);
				await sync.connect({ host, port, fingerprint: body.fingerprint, target: targetOf(body.target), ...(join ? { join } : {}) });
				break;
			}
			case "list-syncs":
				return Response.json({ syncs: await sync.listSyncs() });
			case "change-sync": {
				const join = joinOf(body.join);
				await sync.changeSync(targetOf(body.target), join);
				break;
			}
			case "rename-sync":
				if (typeof body.name !== "string") throw new Error("Give the sync a name");
				await sync.renameSync(body.name);
				break;
			case "reconnect": {
				const endpoint = sync.status().endpoint;
				if (!endpoint) throw new Error("No endpoint to reconnect to");
				await sync.connect(endpoint);
				break;
			}
			case "disconnect":
				sync.disconnect(); break;
			case "forget":
				sync.forget(); break;
			case "sync-now":
				await sync.cycleNow(); break;
			case "resolve": {
				const decision = body.decision;
				if (typeof body.id !== "string" || (decision !== "local" && decision !== "remote" && decision !== "both")) throw new Error("Choose which version to keep");
				await sync.resolve(body.id, decision as ConflictDecision);
				break;
			}
			case "restore-set-aside":
				if (typeof body.id !== "string") throw new Error("Missing snapshot id");
				sync.restoreSetAside(body.id); break;
			case "delete-set-aside":
				if (typeof body.id !== "string") throw new Error("Missing snapshot id");
				sync.deleteSetAside(body.id); break;
			default:
				return Response.json({ error: `Unknown action ${body.action}` }, { status: 400 });
		}
	} catch (err) {
		return Response.json({ error: friendlySyncError(err) }, { status: 400 });
	}
	return Response.json(sync.status());
}

/** SSH errors in learner words; the raw message stays as the fallback. */
function friendlySyncError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const level = (err as { level?: string }).level;
	if (level === "client-authentication" || /All configured authentication methods failed/i.test(message)) return "The endpoint refused this device's key. Run the \"Allow this device\" command on the endpoint, then try again.";
	if (/ECONNREFUSED/.test(message)) return "Nothing answered on that host and port. Check that the SSH server is running and the port is right.";
	if (/ENOTFOUND|EAI_AGAIN/.test(message)) return "That host name could not be found.";
	if (/ETIMEDOUT|Timed out/i.test(message)) return "The endpoint did not answer in time. Check the address and that it is reachable from this network.";
	if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return "The endpoint is not reachable from this network.";
	return message;
}
