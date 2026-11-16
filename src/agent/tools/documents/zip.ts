/**
 * DOCUMENTS — the zip layer (owner plan, 2026-11-16). Office/OpenDocument
 * files and plain .zip archives are all zips: this reads their central
 * directory for the listing (names, sizes, encryption) and inflates ONE
 * entry on demand with fflate. Nothing is extracted to disk.
 *
 * Guard: an entry may be at most MAX_ENTRY_BYTES uncompressed. fflate sizes
 * its output buffer from the declared size, so a lying header cannot
 * inflate past it.
 */
import { unzipSync } from "fflate";

export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

export interface ZipEntry {
	name: string;
	/** Uncompressed size (declared). */
	size: number;
	compressedSize: number;
	directory: boolean;
	encrypted: boolean;
}

const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

/** Zip signature at the start (also the empty-archive EOCD-only form). */
export function looksLikeZip(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const signature = view.getUint32(0, true);
	return signature === LOCAL_SIGNATURE || signature === EOCD_SIGNATURE;
}

export class ZipError extends Error {}

/** The central directory, in archive order. Throws ZipError on corrupt data. */
export function listZip(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
		if (view.getUint32(at, true) === EOCD_SIGNATURE) { eocd = at; break; }
	}
	if (eocd < 0) throw new ZipError("Not a readable zip file (no central directory).");
	let count = view.getUint16(eocd + 10, true);
	let offset = view.getUint32(eocd + 16, true);
	const locator = eocd - 20;
	if ((count === 0xffff || offset === 0xffffffff) && locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
		const zip64 = Number(view.getBigUint64(locator + 8, true));
		if (zip64 + 56 > bytes.length || view.getUint32(zip64, true) !== ZIP64_EOCD_SIGNATURE) throw new ZipError("Not a readable zip file (bad zip64 directory).");
		count = Number(view.getBigUint64(zip64 + 32, true));
		offset = Number(view.getBigUint64(zip64 + 48, true));
	}
	const decoder = new TextDecoder();
	const entries: ZipEntry[] = [];
	for (let index = 0; index < count; index++) {
		if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new ZipError("Not a readable zip file (corrupt central directory).");
		const flags = view.getUint16(offset + 8, true);
		let compressedSize = view.getUint32(offset + 20, true);
		let size = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
		// Zip64 sizes live in the extra field (id 0x0001), uncompressed first.
		let extra = offset + 46 + nameLength;
		const extraEnd = extra + extraLength;
		while (extra + 4 <= extraEnd) {
			const id = view.getUint16(extra, true), length = view.getUint16(extra + 2, true);
			if (id === 0x0001) {
				let field = extra + 4;
				if (size === 0xffffffff && field + 8 <= extraEnd) { size = Number(view.getBigUint64(field, true)); field += 8; }
				if (compressedSize === 0xffffffff && field + 8 <= extraEnd) compressedSize = Number(view.getBigUint64(field, true));
			}
			extra += 4 + length;
		}
		entries.push({ name, size, compressedSize, directory: name.endsWith("/"), encrypted: (flags & 1) === 1 });
		offset = extraEnd + commentLength;
	}
	return entries;
}

/** Normalize an inner path: forward slashes, no leading "./" or "/". */
export function normalizeEntryName(name: string): string {
	return name.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");
}

/** One entry's bytes, or null when absent. Throws on encrypted/oversized/corrupt. */
export function readZipEntry(bytes: Uint8Array, name: string, entries = listZip(bytes)): Uint8Array | null {
	const wanted = normalizeEntryName(name);
	const entry = entries.find(candidate => candidate.name === wanted && !candidate.directory);
	if (!entry) return null;
	if (entry.encrypted) throw new ZipError(`"${wanted}" is encrypted (password-protected) and cannot be read.`);
	if (entry.size > MAX_ENTRY_BYTES) throw new ZipError(`"${wanted}" is ${(entry.size / 1024 / 1024).toFixed(1)} MB uncompressed, over the ${MAX_ENTRY_BYTES / 1024 / 1024} MB limit for a single archive entry.`);
	let files: Record<string, Uint8Array>;
	try { files = unzipSync(bytes, { filter: file => file.name === wanted }); }
	catch (error) { throw new ZipError(`Could not decompress "${wanted}": ${(error as Error).message}`); }
	return files[wanted] ?? null;
}

/** A UTF-8 text entry (XML parts), or null when absent. */
export function readZipText(bytes: Uint8Array, name: string, entries?: ZipEntry[]): string | null {
	const data = readZipEntry(bytes, name, entries);
	return data ? new TextDecoder().decode(data) : null;
}
