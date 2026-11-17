/**
 * Windows ARM64 (2026-11-17): one update feed for two installers.
 * scripts/merge-win-feed.ts merges the x64 and arm64 builds' latest.yml;
 * the result must pass the release gate's feed check, and electron-updater's
 * own file selection must hand each architecture its own installer.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { mergeWinFeeds } from "../scripts/merge-win-feed.ts";
import { expectedAssets, verifyMetadataFiles, type ReleaseRecord } from "../scripts/verify-release.ts";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): any };
const { findFile, resolveFiles } = require("electron-updater/out/providers/Provider.js") as {
	findFile(files: Array<{ url: URL; info: { url: string } }>, extension: string): { url: URL; info: { url: string } };
	resolveFiles(info: unknown, baseUrl: URL): Array<{ url: URL; info: { url: string } }>;
};

const V = "0.6.4";
const digest = (seed: string) => Buffer.from(seed.padEnd(64, "x")).toString("base64");
/** A feed shaped exactly like app-builder-lib writes for one NSIS build. */
const feed = (arch: "x64" | "arm64", size: number, version = V) => {
	const url = `LearnHarness-${version}-${arch}-setup.exe`;
	return `version: ${version}\nfiles:\n  - url: ${url}\n    sha512: ${digest(arch)}\n    size: ${size}\npath: ${url}\nsha512: ${digest(arch)}\nreleaseDate: '2026-11-17T10:00:00.000Z'\n`;
};

describe("merge-win-feed", () => {
	it("lists x64 first then arm64, keeping x64 in the legacy top-level fields", () => {
		const merged = yaml.load(mergeWinFeeds(feed("x64", 1000), feed("arm64", 900)));
		assert.equal(merged.version, V);
		assert.deepEqual(merged.files.map((f: { url: string }) => f.url), [`LearnHarness-${V}-x64-setup.exe`, `LearnHarness-${V}-arm64-setup.exe`]);
		assert.deepEqual(merged.files.map((f: { size: number }) => f.size), [1000, 900]);
		assert.equal(merged.path, `LearnHarness-${V}-x64-setup.exe`);
		assert.equal(merged.sha512, digest("x64"));
		assert.equal(merged.releaseDate, "2026-11-17T10:00:00.000Z");
	});

	it("passes the release gate's feed check for a 13-asset draft", () => {
		const expected = expectedAssets(V);
		const sizes: Record<string, number> = { [expected.win.exe]: 1000, [expected.win.exeArm64]: 900 };
		const release: ReleaseRecord = { id: 1, tag_name: `v${V}`, draft: true, assets: expected.files.map((name, i) => ({ id: i + 1, name, size: sizes[name] ?? 5000, state: "uploaded" })) };
		const other = (file: string, urls: string[]) => `version: ${V}\nfiles:\n${urls.map((u) => `  - url: ${u}\n    sha512: ${digest(u)}\n    size: 5000\n`).join("")}path: ${urls[0]}\nsha512: ${digest(urls[0]!)}\n`;
		const verdict = verifyMetadataFiles({
			"latest.yml": mergeWinFeeds(feed("x64", 1000), feed("arm64", 900)),
			"latest-mac.yml": other("latest-mac.yml", [expected.mac.zip, expected.mac.dmg]),
			"latest-linux.yml": other("latest-linux.yml", [expected.linux.appImage, expected.linux.deb]),
		}, release, expected);
		assert.ok(verdict.ok, JSON.stringify(verdict, null, 2));
	});

	it("electron-updater gives each architecture its own installer", () => {
		const info = yaml.load(mergeWinFeeds(feed("x64", 1000), feed("arm64", 900)));
		const files = resolveFiles(info, new URL("https://github.com/owner/repo/releases/download/v0.6.4/"));
		const original = Object.getOwnPropertyDescriptor(process, "arch")!;
		const pick = (arch: string) => {
			Object.defineProperty(process, "arch", { ...original, value: arch });
			try { return findFile(files, "exe").info.url; }
			finally { Object.defineProperty(process, "arch", original); }
		};
		assert.equal(pick("x64"), `LearnHarness-${V}-x64-setup.exe`, "x64 installs (including x64 emulated on ARM64) stay on x64");
		assert.equal(pick("arm64"), `LearnHarness-${V}-arm64-setup.exe`, "native arm64 installs update with the arm64 installer");
		assert.equal(pick("ia32"), `LearnHarness-${V}-x64-setup.exe`, "anything else falls back to files[0], the x64 installer");
	});

	it("fails closed on mismatched or unexpected feeds", () => {
		assert.throws(() => mergeWinFeeds(feed("x64", 1), feed("arm64", 1, "0.6.5")), /version mismatch/);
		assert.throws(() => mergeWinFeeds(feed("arm64", 1), feed("x64", 1)), /x64 feed lists "LearnHarness-0\.6\.4-arm64-setup\.exe"/);
		assert.throws(() => mergeWinFeeds(feed("x64", 1), feed("x64", 1)), /arm64 feed lists/);
		assert.throws(() => mergeWinFeeds(mergeWinFeeds(feed("x64", 1), feed("arm64", 1)), feed("arm64", 1)), /exactly one file/);
		assert.throws(() => mergeWinFeeds("not: [yaml", feed("arm64", 1)), /does not parse/);
		assert.throws(() => mergeWinFeeds("version: 0.6.4\n", feed("arm64", 1)), /exactly one file/);
	});
});
