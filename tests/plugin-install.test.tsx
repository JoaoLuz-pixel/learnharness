/**
 * Community plugins from a .zip + updates from GitHub releases (owner,
 * 2026-11-21): ready-built only, nothing run, duplicates refused, data kept
 * on update, and the new Settings layout.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { strToU8, zipSync } from "fflate";
import {
	checkPluginUpdates, clearReleaseCache, compareVersions, downloadPluginUpdate, githubRepository, inspectPluginZip,
	assertNotInstalled, installedFolderInfo, installPluginPackage, pickPluginAsset, uninstallPluginFolder, replacePluginPackage, type InstallPaths,
} from "../src/server/plugin-install.ts";
import { InstallDialogBody, PluginsSection, UninstallDialogBody } from "../components/settings/plugins-section.tsx";

const manifest = (patch: Record<string, unknown> = {}) => JSON.stringify({ apiVersion: 1, id: "hello-world", name: "Hello World", version: "1.0.0", minAppVersion: "0.6.1", main: "main.js", author: "Ada", ...patch });
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const built = (prefix = "", patch: Record<string, unknown> = {}) => zip({ [`${prefix}manifest.json`]: manifest(patch), [`${prefix}main.js`]: "export function activate() {}", [`${prefix}assets/icon.svg`]: "<svg/>" });

let paths: InstallPaths;
beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugin-install-"));
	paths = { pluginDirectory: path.join(root, "plugins"), stagingDirectory: path.join(root, ".plugin-install") };
	clearReleaseCache();
});

describe("checking a zip (nothing is run)", () => {
	it("finds the built plugin at the top, in dist/, or inside one wrapping folder", () => {
		for (const prefix of ["", "dist/", "hello-world-1.0.0/", "repo-main/dist/"]) {
			const pkg = inspectPluginZip(built(prefix), "0.6.4");
			assert.equal(pkg.manifest.id, "hello-world", prefix);
			assert.deepEqual([...pkg.files.keys()].sort(), ["assets/icon.svg", "main.js", "manifest.json"], prefix);
		}
	});
	it("refuses source-only zips with a build-it-first message", () => {
		assert.throws(() => inspectPluginZip(zip({ "my-plugin/package.json": "{}", "my-plugin/src/main.ts": "" }), "0.6.4"), /source code, not a built plugin/);
		assert.throws(() => inspectPluginZip(zip({ "readme.txt": "hi" }), "0.6.4"), /no manifest\.json/);
		assert.throws(() => inspectPluginZip(strToU8("not a zip"), "0.6.4"), /not a readable \.zip/);
	});
	it("refuses unsafe paths, missing entries, reserved ids and incompatible apps", () => {
		assert.throws(() => inspectPluginZip(zip({ "manifest.json": manifest(), "main.js": "", "../evil.js": "" }), "0.6.4"), /unsafe path/);
		assert.throws(() => inspectPluginZip(zip({ "manifest.json": manifest(), "main.js": "", "a\\b.js": "" }), "0.6.4"), /unsafe path/);
		assert.throws(() => inspectPluginZip(zip({ "manifest.json": manifest() }), "0.6.4"), /main\.js is missing/);
		assert.throws(() => inspectPluginZip(built("", { id: "flashcards" }), "0.6.4"), /reserved for a Core plugin/);
		assert.throws(() => inspectPluginZip(built("", { minAppVersion: "9.0.0" }), "0.6.4"), /Requires LearnHarness 9\.0\.0/);
		assert.throws(() => inspectPluginZip(built("", { id: "Bad_Id" }), "0.6.4"), /no valid id/);
	});
	it("never ships a data/ folder, and reads an optional GitHub repository", () => {
		const pkg = inspectPluginZip(zip({ "manifest.json": manifest({ repository: "https://github.com/ada/hello-world.git" }), "main.js": "", "data/secret.json": "{}" }), "0.6.4");
		assert.equal(pkg.files.has("data/secret.json"), false);
		assert.equal(pkg.repository, "ada/hello-world");
		assert.equal(githubRepository("ada/hello"), "ada/hello");
		for (const bad of ["", "ada", "https://evil.com/ada/hello", "ada/../x", "../x", 42]) assert.equal(githubRepository(bad), undefined, String(bad));
	});
});

describe("installing", () => {
	it("copies a new plugin into <id>/dist via a staging folder beside plugins/", () => {
		installPluginPackage(inspectPluginZip(built(), "0.6.4"), paths);
		assert.ok(fs.existsSync(path.join(paths.pluginDirectory, "hello-world", "dist", "manifest.json")));
		assert.ok(fs.existsSync(path.join(paths.pluginDirectory, "hello-world", "dist", "assets", "icon.svg")));
		assert.deepEqual(fs.readdirSync(paths.pluginDirectory), ["hello-world"], "no staging folder inside plugins/ (it would read as a plugin)");
	});
	it("refuses an already-installed plugin and names its version, without touching it", () => {
		installPluginPackage(inspectPluginZip(built(), "0.6.4"), paths);
		fs.mkdirSync(path.join(paths.pluginDirectory, "hello-world", "data"));
		fs.writeFileSync(path.join(paths.pluginDirectory, "hello-world", "data", "notes.json"), "kept");
		assert.throws(() => installPluginPackage(inspectPluginZip(built("", { version: "2.0.0" }), "0.6.4"), paths), /Hello World v1\.0\.0 is already installed/);
		assert.throws(() => assertNotInstalled("hello-world", paths), /already installed/, "checked before any dialog opens");
		assert.doesNotThrow(() => assertNotInstalled("other-plugin", paths));
		assert.match(fs.readFileSync(new URL("../app/api/plugin-install/route.ts", import.meta.url), "utf8"), /inspectPluginZip\(bytes\);\s*assertNotInstalled\(pkg\.manifest\.id\)/);
		assert.equal(JSON.parse(fs.readFileSync(path.join(paths.pluginDirectory, "hello-world", "dist", "manifest.json"), "utf8")).version, "1.0.0");
	});
});

describe("updating from GitHub releases", () => {
	const release = (tag: string, assets: { name: string; url?: string }[]) => ({ tag_name: tag, assets: assets.map(a => ({ name: a.name, size: 1000, browser_download_url: a.url ?? `https://github.com/ada/hello-world/releases/download/${tag}/${a.name}` })) });
	const fakeFetch = (rel: unknown, zipBytes?: Uint8Array) => (async (input: string | URL) => {
		const url = String(input);
		if (url.startsWith("https://api.github.com/repos/ada/hello-world/releases/latest")) return Response.json(rel);
		if (url.startsWith("https://github.com/") && zipBytes) return new Response(new Blob([new Uint8Array(zipBytes)]));
		return new Response("nope", { status: 404 });
	}) as typeof fetch;
	const installV1 = () => {
		installPluginPackage(inspectPluginZip(built("", { repository: "ada/hello-world" }), "0.6.4"), paths);
		fs.mkdirSync(path.join(paths.pluginDirectory, "hello-world", "data"));
		fs.writeFileSync(path.join(paths.pluginDirectory, "hello-world", "data", "notes.json"), "kept");
	};

	it("versions, asset choice", () => {
		assert.ok(compareVersions("1.2.0", "1.10.0") < 0);
		assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
		assert.equal(compareVersions("garbage", "1.0.0"), 0, "unknown never counts as newer");
		const assets = [{ name: "source.zip", size: 1, browser_download_url: "x" }, { name: "hello-world-1.1.0.zip", size: 1, browser_download_url: "y" }];
		assert.equal(pickPluginAsset("hello-world", assets)?.name, "hello-world-1.1.0.zip");
		assert.equal(pickPluginAsset("hello-world", [assets[0]!])?.name, "source.zip", "a single zip is used");
		assert.equal(pickPluginAsset("hello-world", [...assets.slice(0, 1), { name: "other.zip", size: 1, browser_download_url: "z" }]), null, "ambiguous");
	});
	it("reports a newer release, and replaces the code while keeping data/", async () => {
		installV1();
		const v2 = built("hello-world/", { version: "1.1.0", repository: "ada/hello-world" });
		const fetchImpl = fakeFetch(release("v1.1.0", [{ name: "hello-world-1.1.0.zip" }]), v2);
		const [info] = await checkPluginUpdates(["hello-world"], fetchImpl, paths);
		assert.deepEqual(info, { id: "hello-world", current: "1.0.0", repository: "ada/hello-world", latest: "1.1.0", available: true });
		const pkg = await downloadPluginUpdate("hello-world", fetchImpl, paths);
		assert.deepEqual(replacePluginPackage(pkg, paths), { from: "1.0.0" });
		const root = path.join(paths.pluginDirectory, "hello-world");
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "dist", "manifest.json"), "utf8")).version, "1.1.0");
		assert.equal(fs.readFileSync(path.join(root, "data", "notes.json"), "utf8"), "kept");
		assert.deepEqual(fs.readdirSync(paths.stagingDirectory), [], "no backup left behind");
	});
	it("no update for the same version; refuses non-github downloads, other plugins, and older versions", async () => {
		installV1();
		assert.equal((await checkPluginUpdates(["hello-world"], fakeFetch(release("v1.0.0", [{ name: "hello-world.zip" }])), paths))[0]!.available, false);
		clearReleaseCache();
		await assert.rejects(downloadPluginUpdate("hello-world", fakeFetch(release("v2.0.0", [{ name: "hello-world.zip", url: "https://evil.example/x.zip" }])), paths), /not on github\.com/);
		clearReleaseCache();
		await assert.rejects(downloadPluginUpdate("hello-world", fakeFetch(release("v2.0.0", [{ name: "hello-world.zip" }]), built("", { id: "other-plugin", version: "2.0.0" })), paths), /holds “other-plugin”/);
		assert.throws(() => replacePluginPackage(inspectPluginZip(built("", { version: "0.9.0" }), "0.6.4"), paths), /not newer/);
	});
	it("plugins without a repository are not checked", async () => {
		installPluginPackage(inspectPluginZip(built(), "0.6.4"), paths);
		assert.deepEqual(await checkPluginUpdates(["hello-world"], (async () => { throw new Error("must not call"); }) as typeof fetch, paths), []);
	});
});

describe("Community plugins page", () => {
	it("puts install first and tucks the manual details into a closed Advanced section", () => {
		const html = renderToStaticMarkup(<PluginsSection />);
		assert.ok(html.indexOf('data-testid="plugin-install"') < html.indexOf('data-testid="plugin-advanced"'));
		assert.match(html, /Install plugin from file…/);
		assert.match(html, /accept="\.zip,application\/zip"/);
		assert.match(html, /drop a plugin <code>\.zip<\/code> here/);
		const advanced = html.slice(html.indexOf('data-testid="plugin-advanced"'));
		for (const id of ["plugin-install-help", "plugin-authoring-help", "plugin-directory"]) assert.ok(advanced.includes(`data-testid="${id}"`), id);
		assert.doesNotMatch(html, /<details[^>]*data-testid="plugin-advanced"[^>]*open/);
		assert.doesNotMatch(renderToStaticMarkup(<PluginsSection origin="core" />), /Install plugin from file/);
	});
	it("the install dialog shows what it is, warns, and leaves enabling off by default", () => {
		const html = renderToStaticMarkup(<InstallDialogBody summary={{ id: "hello-world", name: "Hello World", version: "1.0.0", minAppVersion: "0.6.1", author: "Ada", description: "Says hi", repository: "ada/hello-world", frontend: true, backend: true }} onCancel={() => {}} onInstall={async () => {}} />);
		assert.match(html, /Install Hello World\?/);
		assert.match(html, /data-testid="install-version">1\.0\.0/);
		assert.match(html, /Ada/);
		assert.match(html, /on the app(&#x27;|')s server \(files and network\)/);
		assert.match(html, /github\.com\/ada\/hello-world/);
		assert.match(html, /not sandboxed/);
		assert.match(html, /<input type="checkbox" data-testid="install-enable"\/>/, "unchecked");
	});
});

describe("uninstalling (owner, 2026-11-21)", () => {
	it("a zip-installed plugin: its whole folder goes, code AND data", () => {
		installPluginPackage(inspectPluginZip(built(), "0.6.4"), paths);
		fs.mkdirSync(path.join(paths.pluginDirectory, "hello-world", "data"));
		fs.writeFileSync(path.join(paths.pluginDirectory, "hello-world", "data", "notes.json"), "x");
		assert.equal(installedFolderInfo("hello-world", paths).kind, "package");
		uninstallPluginFolder("hello-world", paths);
		assert.deepEqual(fs.readdirSync(paths.pluginDirectory), []);
	});
	it("a development folder (git clone) is recognised, its remote shown without credentials, and removed", () => {
		const dir = path.join(paths.pluginDirectory, "dev-plugin");
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://ada:ghp_SECRET@github.com/ada/dev-plugin.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
		// Git keeps its objects read-only: the delete must still get through.
		fs.mkdirSync(path.join(dir, ".git", "objects", "ab"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".git", "objects", "ab", "cdef"), "blob");
		fs.chmodSync(path.join(dir, ".git", "objects", "ab", "cdef"), 0o444);
		fs.chmodSync(path.join(dir, ".git", "objects", "ab"), 0o555);
		const info = installedFolderInfo("dev-plugin", paths);
		assert.equal(info.kind, "development");
		assert.equal(info.remote, "https://github.com/ada/dev-plugin.git");
		assert.doesNotMatch(JSON.stringify(info), /SECRET|ada:/);
		uninstallPluginFolder("dev-plugin", paths);
		assert.equal(fs.existsSync(dir), false);
	});
	it("a linked folder: only the link goes, never what it points to", () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "lh-linked-plugin-"));
		fs.writeFileSync(path.join(target, "keep.txt"), "mine");
		fs.mkdirSync(paths.pluginDirectory, { recursive: true });
		fs.symlinkSync(target, path.join(paths.pluginDirectory, "linked-plugin"), "dir");
		assert.equal(installedFolderInfo("linked-plugin", paths).link, true);
		uninstallPluginFolder("linked-plugin", paths);
		assert.equal(fs.existsSync(path.join(paths.pluginDirectory, "linked-plugin")), false);
		assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "mine");
	});
	it("refuses Core plugins, bad ids and missing folders", () => {
		assert.throws(() => uninstallPluginFolder("flashcards", paths), /Core plugins can't be uninstalled/);
		for (const bad of ["../x", "", "A", "x/y"]) assert.throws(() => uninstallPluginFolder(bad, paths), /Unknown plugin/, bad);
		assert.throws(() => uninstallPluginFolder("not-installed", paths), /no longer exists/);
	});
	it("the confirmation explains what is deleted, per kind of folder", () => {
		const dev = renderToStaticMarkup(<UninstallDialogBody name="Dev" version="0.1.0" folder={{ id: "dev", kind: "development", link: false, remote: "https://github.com/ada/dev.git", path: "/p/dev" }} busy={false} error="" onCancel={() => {}} onConfirm={() => {}} />);
		assert.match(dev, /Uninstall Dev v0\.1\.0\?/);
		assert.match(dev, /local copy of a git repository/);
		assert.match(dev, /repository online is not touched/);
		assert.match(dev, /https:\/\/github\.com\/ada\/dev\.git/);
		assert.match(dev, /never pushed are lost/);
		const pkg = renderToStaticMarkup(<UninstallDialogBody name="Hello" folder={{ id: "hello", kind: "package", link: false, path: "/p/hello" }} busy={false} error="" onCancel={() => {}} onConfirm={() => {}} />);
		assert.match(pkg, /code and all the data it saved are deleted/);
		assert.doesNotMatch(pkg, /git repository/);
		assert.doesNotMatch(pkg, /run briefly/, "an enabled plugin just gets its trigger");
		const off = renderToStaticMarkup(<UninstallDialogBody name="Sync helper" folder={{ id: "sync-helper", kind: "package", link: false, path: "/p/s" }} busy={false} error="" onCancel={() => {}} onConfirm={() => {}} startsBriefly />);
		assert.match(off, /Sync helper will run briefly to clean up before it(&#x27;|')s removed\./);
	});
});
