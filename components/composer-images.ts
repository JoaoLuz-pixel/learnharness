import type { ImageContent } from "@earendil-works/pi-ai";

/** The composer's image admission (paste/drop): the same per-file ceiling
 *  as learner images (MAX_LEARNER_IMAGE_BYTES), no count cap. Byte
 *  sniffing here only gates what is staged; the server still verifies,
 *  decodes and re-encodes every image before the model sees it. */
export const MAX_COMPOSER_IMAGE_BYTES = 25 * 1024 * 1024;
export const COMPOSER_IMAGE_FORMATS = "PNG, JPEG, WebP or GIF";
export const UNSUPPORTED_IMAGE_NOTICE = `Only ${COMPOSER_IMAGE_FORMATS} images can be attached.`;
export const OVERSIZED_IMAGE_NOTICE = "Images must be 25 MiB or smaller.";

export type ComposerImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Signature sniffing: a declared type is never trusted. SVG is excluded. */
export function sniffComposerImageMime(bytes: Uint8Array): ComposerImageMime | null {
	const at = (offset: number, signature: number[]) => signature.every((byte, index) => bytes[offset + index] === byte);
	if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (at(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
	if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
	return null;
}

/** Canonical (padded) base64 without a Node Buffer. Chunked so large
 *  images never overflow the argument limit of String.fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** Files that claim to be images. Admission still sniffs their bytes. */
export function imageFilesOf(files: Iterable<File>): File[] {
	return Array.from(files).filter(file => file.type.startsWith("image/"));
}

export type ImageAdmission = { images: ImageContent[]; notice: string };

/** Read and admit image files; rejected files only produce a notice. */
export async function admitComposerImages(files: readonly File[]): Promise<ImageAdmission> {
	const images: ImageContent[] = [];
	let oversized = false, unsupported = false;
	for (const file of files) {
		if (file.size > MAX_COMPOSER_IMAGE_BYTES) { oversized = true; continue; }
		let bytes: Uint8Array;
		try { bytes = new Uint8Array(await file.arrayBuffer()); }
		catch { unsupported = true; continue; }
		const mimeType = bytes.length ? sniffComposerImageMime(bytes) : null;
		if (!mimeType) { unsupported = true; continue; }
		images.push({ type: "image", data: bytesToBase64(bytes), mimeType });
	}
	return { images, notice: [unsupported ? UNSUPPORTED_IMAGE_NOTICE : "", oversized ? OVERSIZED_IMAGE_NOTICE : ""].filter(Boolean).join(" ") };
}
