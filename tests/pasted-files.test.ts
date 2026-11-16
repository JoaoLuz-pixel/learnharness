import assert from "node:assert/strict";
import { test } from "node:test";
import { fileUriToPath, fileUrisToPaths, pastedFilePaths } from "../components/pasted-files.ts";

const pdf = () => new File(["%PDF"], "notes one.pdf", { type: "application/pdf" });
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });

test("file:// URIs become rooted paths; other schemes and junk are refused", () => {
	assert.equal(fileUriToPath("file:///home/me/notes%20one.pdf"), "/home/me/notes one.pdf");
	assert.equal(fileUriToPath("file://localhost/home/me/a.pdf"), "/home/me/a.pdf");
	assert.equal(fileUriToPath("file:///C:/Users/me/a.pdf"), "C:\\Users\\me\\a.pdf");
	assert.equal(fileUriToPath("file://server/share/a.pdf"), "\\\\server\\share\\a.pdf");
	assert.equal(fileUriToPath("https://example.com/a.pdf"), null);
	assert.equal(fileUriToPath("not a uri"), null);
	assert.equal(fileUriToPath("file:///home/me/%E0%A4%A"), null, "malformed escapes are refused");
});

test("only text made entirely of file addresses counts as a file copy", () => {
	assert.deepEqual(fileUrisToPaths("file:///a/one.pdf\r\nfile:///a/two%20b.pdf\r\n"), ["/a/one.pdf", "/a/two b.pdf"]);
	assert.deepEqual(fileUrisToPaths("# comment\nfile:///a/one.pdf"), ["/a/one.pdf"], "uri-list comments are skipped");
	assert.deepEqual(fileUrisToPaths("x-special/nautilus-clipboard\ncopy\nfile:///a/one.pdf\n"), ["/a/one.pdf"], "GNOME's clipboard text");
	assert.deepEqual(fileUrisToPaths("cut\nfile:///a/one.pdf"), ["/a/one.pdf"]);
	assert.equal(fileUrisToPaths("see file:///a/one.pdf"), null, "prose is text");
	assert.equal(fileUrisToPaths("file:///a/one.pdf\nhttps://x.y"), null, "one non-file line keeps it all text");
	assert.equal(fileUrisToPaths(""), null);
	assert.equal(fileUrisToPaths("/a/one.pdf"), null, "a plain path is ordinary text");
});

test("desktop: non-image files resolve to paths, images are left to the image strip", () => {
	const resolve = (file: File) => file.name === "notes one.pdf" ? "/docs/notes one.pdf" : "";
	const result = pastedFilePaths({ files: [png(), pdf()], getData: () => "file:///ignored.pdf" }, resolve);
	assert.deepEqual(result, { paths: ["/docs/notes one.pdf"], unresolved: false, fromText: false });
});

test("desktop: folders get a directory reference; files without a path are reported", () => {
	const folder = new File([], "course");
	const items = [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }, { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) }];
	const result = pastedFilePaths({ files: [folder, pdf()], items }, (file) => file === folder ? "/docs/course" : "");
	assert.deepEqual(result, { paths: ["/docs/course/"], unresolved: true, fromText: false });
});

test("browser: documents cannot become paths and file:// text is not converted", () => {
	assert.deepEqual(pastedFilePaths({ files: [pdf()], getData: () => "" }, undefined), { paths: [], unresolved: true, fromText: false });
	assert.deepEqual(pastedFilePaths({ files: [], getData: () => "file:///a/one.pdf" }, undefined), { paths: [], unresolved: false, fromText: false });
});

test("Linux workaround: no files but file:// text → chips from text/uri-list, else text/plain", () => {
	const resolve = () => "";
	const uriList = pastedFilePaths({ files: [], getData: (type) => type === "text/uri-list" ? "file:///a/one.pdf" : "/a/one.pdf" }, resolve);
	assert.deepEqual(uriList, { paths: ["/a/one.pdf"], unresolved: false, fromText: true });
	const gnome = pastedFilePaths({ files: [], getData: (type) => type === "text/plain" ? "x-special/nautilus-clipboard\ncopy\nfile:///a/two.pdf" : "" }, resolve);
	assert.deepEqual(gnome, { paths: ["/a/two.pdf"], unresolved: false, fromText: true });
	assert.deepEqual(pastedFilePaths({ files: [], getData: () => "hello" }, resolve), { paths: [], unresolved: false, fromText: false });
	assert.deepEqual(pastedFilePaths({ files: [png()], getData: () => "file:///a/one.pdf" }, resolve), { paths: [], unresolved: false, fromText: false }, "a real file wins over text");
});
