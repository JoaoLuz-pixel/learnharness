/**
 * DEVICE SYNC — sync passwords (owner, 2026-11-28). A password is set only
 * when a sync is created and can never be changed or removed. It encrypts
 * everything the sync stores on its endpoint, so the endpoint's owner or the
 * cloud provider cannot read it.
 *
 *  - scrypt(password, salt) → a 32-byte master key. Devices keep only this
 *    master key (in the system's secure storage), never the password.
 *  - HKDF(master) → three independent keys:
 *      data  AES-256-GCM for every stored file (random 12-byte IV, the
 *            file's place in the sync as associated data, so a file moved
 *            to another name fails to open);
 *      names HMAC for content-addressed blob names (hides content hashes);
 *      auth  proves the password to a built-in host, which stores only a
 *            check value made from it and never learns the data key.
 *  - check = HMAC(auth, "lh-sync-check:" + syncId) is kept with the sync,
 *    so a device can tell a wrong password before touching anything.
 */
import { createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";

export const SYNC_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAGIC = Buffer.from("LHE1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Stored with a protected sync (plain JSON, no secrets). */
export interface SyncCryptoParams {
	kdf: "scrypt";
	/** base64 */
	salt: string;
	N: number;
	r: number;
	p: number;
	/** base64 HMAC(auth, "lh-sync-check:" + syncId) */
	check: string;
}

export interface SyncKeys {
	master: Buffer;
	data: Buffer;
	names: Buffer;
	auth: Buffer;
}

export class WrongSyncPasswordError extends Error {
	constructor() { super("That password is not right for this sync."); }
}

/** Passwords: at least 8 characters, at most 256. */
export function checkPasswordShape(password: unknown): string {
	if (typeof password !== "string" || password.length < 8) throw new Error("The password needs at least 8 characters.");
	if (password.length > 256) throw new Error("The password can have at most 256 characters.");
	return password;
}

function scrypt(password: string, salt: Buffer, params: Pick<SyncCryptoParams, "N" | "r" | "p">): Promise<Buffer> {
	return new Promise((resolve, reject) => scryptCb(password.normalize("NFC"), salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
		(err, key) => (err ? reject(err) : resolve(key))));
}

/** The three working keys from a master key. */
export function keysFromMaster(master: Buffer): SyncKeys {
	if (master.length !== 32) throw new Error("A sync key must be 32 bytes");
	const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(info), 32));
	return { master, data: derive("lh-sync-data"), names: derive("lh-sync-names"), auth: derive("lh-sync-auth") };
}

export function authCheck(auth: Buffer, syncId: string): Buffer {
	return createHmac("sha256", auth).update(`lh-sync-check:${syncId}`).digest();
}

/** Does this auth key match the sync's check value? Constant time. */
export function authMatches(auth: Buffer, syncId: string, check: string): boolean {
	const expected = Buffer.from(check, "base64");
	const actual = authCheck(auth, syncId);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** New params + keys for a sync being created with this password. */
export async function createSyncCrypto(password: string, syncId: string, kdf: Pick<SyncCryptoParams, "N" | "r" | "p"> = SYNC_KDF): Promise<{ params: SyncCryptoParams; keys: SyncKeys }> {
	checkPasswordShape(password);
	const salt = randomBytes(16);
	const keys = keysFromMaster(await scrypt(password, salt, kdf));
	return { params: { kdf: "scrypt", salt: salt.toString("base64"), N: kdf.N, r: kdf.r, p: kdf.p, check: authCheck(keys.auth, syncId).toString("base64") }, keys };
}

/** Keys from a typed password, without checking it (a host checks it). */
export async function deriveSyncKeys(password: string, params: Omit<SyncCryptoParams, "check">): Promise<SyncKeys> {
	if (params.kdf !== "scrypt" || ![params.N, params.r, params.p].every(n => Number.isSafeInteger(n) && n > 0) || params.N > 2 ** 20 || params.r > 32 || params.p > 16 || typeof params.salt !== "string") throw new Error("This sync uses settings this app does not support.");
	return keysFromMaster(await scrypt(password, Buffer.from(params.salt, "base64"), params));
}

/** Keys from a typed password; throws WrongSyncPasswordError when it does not match. */
export async function unlockSync(password: string, syncId: string, params: SyncCryptoParams): Promise<SyncKeys> {
	const keys = await deriveSyncKeys(password, params);
	if (!authMatches(keys.auth, syncId, params.check)) throw new WrongSyncPasswordError();
	return keys;
}

/** Encrypt `bytes`, bound to `place` (its path inside the sync). */
export function seal(keys: SyncKeys, bytes: Buffer, place: string): Buffer {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", keys.data, iv);
	cipher.setAAD(Buffer.from(place));
	const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
	return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export class SyncDecryptError extends Error {
	constructor(place: string) { super(`A file in this sync could not be decrypted (${place}). It may be damaged, or not from this sync.`); }
}

/** Decrypt what `seal` made for the same place; throws SyncDecryptError. */
export function open(keys: SyncKeys, sealed: Buffer, place: string): Buffer {
	if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new SyncDecryptError(place);
	const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
	const tag = sealed.subarray(sealed.length - TAG_BYTES);
	const body = sealed.subarray(MAGIC.length + IV_BYTES, sealed.length - TAG_BYTES);
	try {
		const decipher = createDecipheriv("aes-256-gcm", keys.data, iv);
		decipher.setAAD(Buffer.from(place));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]);
	} catch { throw new SyncDecryptError(place); }
}

/** A blob's stored name: the content hash itself, or (protected syncs) an
 *  HMAC of it, so the endpoint cannot match contents across syncs. */
export function blobName(keys: SyncKeys | null, hash: string): string {
	return keys ? createHmac("sha256", keys.names).update(hash).digest("hex") : hash;
}
