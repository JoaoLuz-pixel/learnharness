/**
 * merge-win-feed.ts — one Windows update feed for two installers (2026-11-17).
 *
 * Windows ships one NSIS installer per architecture, each built natively on
 * its own runner (x64 and arm64), but electron-updater reads a single
 * `latest.yml`. Each build writes its own feed; this script merges them:
 *
 *   files:   [x64 entry, arm64 entry]  — x64 FIRST, so the legacy
 *            top-level path/sha512 (backed by files[0]) keep pointing at
 *            the x64 installer that every existing install already uses;
 *   path, sha512, releaseDate: taken from the x64 feed.
 *
 * electron-updater's NSIS updater then picks the file whose name contains
 * its own process.arch (Provider.findFile), so x64 installs stay on x64 and
 * arm64 installs update with the arm64 installer.
 *
 * Fail-closed: both feeds must parse, carry the same version, and hold
 * exactly one entry each — the x64 and arm64 setup .exe for that version.
 *
 * CLI: tsx scripts/merge-win-feed.ts <x64 latest.yml> <arm64 latest.yml>
 *      → merged YAML on stdout; errors on stderr, exit 1.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Same loading as verify-release.ts (js-yaml ships with the builder tooling).
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): unknown; dump(value: unknown, options?: Record<string, unknown>): string };

const PRODUCT_NAME = "LearnHarness";

type FeedEntry = { url: string; sha512: string; size: number; [key: string]: unknown };
type Feed = { version: string; files: FeedEntry[]; path?: string; sha512?: string; releaseDate?: string; [key: string]: unknown };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseFeed(text: string, label: string): Feed {
	let value: unknown;
	try { value = yaml.load(text); }
	catch (error) { throw new Error(`${label}: does not parse as YAML (${String(error)})`); }
	if (!isObject(value)) throw new Error(`${label}: top level is not a mapping`);
	if (typeof value.version !== "string" || value.version === "") throw new Error(`${label}: missing version`);
	if (!Array.isArray(value.files) || value.files.length !== 1) throw new Error(`${label}: must list exactly one file (found ${Array.isArray(value.files) ? value.files.length : "none"})`);
	const entry = value.files[0];
	if (!isObject(entry) || typeof entry.url !== "string" || typeof entry.sha512 !== "string" || typeof entry.size !== "number") {
		throw new Error(`${label}: files[0] must have url, sha512 and size`);
	}
	return value as Feed;
}

export function mergeWinFeeds(x64Text: string, arm64Text: string): string {
	const x64 = parseFeed(x64Text, "x64 feed");
	const arm64 = parseFeed(arm64Text, "arm64 feed");
	if (x64.version !== arm64.version) throw new Error(`version mismatch: x64 ${x64.version}, arm64 ${arm64.version}`);
	const version = x64.version;
	const expected = { x64: `${PRODUCT_NAME}-${version}-x64-setup.exe`, arm64: `${PRODUCT_NAME}-${version}-arm64-setup.exe` };
	if (x64.files[0]!.url !== expected.x64) throw new Error(`x64 feed lists "${x64.files[0]!.url}", expected "${expected.x64}"`);
	if (arm64.files[0]!.url !== expected.arm64) throw new Error(`arm64 feed lists "${arm64.files[0]!.url}", expected "${expected.arm64}"`);
	if (x64.path !== undefined && x64.path !== expected.x64) throw new Error(`x64 feed path is "${x64.path}", expected "${expected.x64}"`);
	const merged: Feed = { ...x64, files: [x64.files[0]!, arm64.files[0]!], path: x64.files[0]!.url, sha512: x64.files[0]!.sha512 };
	return yaml.dump(merged, { lineWidth: -1, noRefs: true });
}

function main(argv: string[]): number {
	if (argv.length !== 2) {
		console.error("usage: tsx scripts/merge-win-feed.ts <x64 latest.yml> <arm64 latest.yml>");
		return 1;
	}
	try {
		process.stdout.write(mergeWinFeeds(fs.readFileSync(argv[0]!, "utf8"), fs.readFileSync(argv[1]!, "utf8")));
		return 0;
	} catch (error) {
		console.error(`[merge-win-feed] ${(error as Error).message}`);
		return 1;
	}
}

const invokedAsCli = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) process.exitCode = main(process.argv.slice(2));
