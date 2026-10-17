import type { BackendLogger } from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import type { KeyPassword, KeyPasswordAtRest, StoredSession } from "./session";
import { parseKeyPassword } from "./session";
import type { ProtonTransport } from "./transport";
import { ProtonApiError } from "./transport";

/**
 * Keeps the key password out of SecretStorage in plaintext, the way Proton's own web
 * clients persist a session (WebClients `getLocalKey`/`setLocalKey`): a random client key
 * is registered with Proton for this session, and only the key password's AES-GCM
 * ciphertext is stored. The key is fetched again for every connection; once the session
 * is revoked (Disconnect, "sign out of all sessions", a password change), every stored or
 * copied blob is undecryptable for good.
 */

const LOCAL_KEY_PATH = "auth/v4/sessions/local/key";
const IV_LENGTH = 12;
/** Binds a blob to the session it was sealed for. */
const AAD_PREFIX = "air-sync/protondrive/key-password/";

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function aesKey(raw: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

const additionalData = (uid: string) => new TextEncoder().encode(AAD_PREFIX + uid);

/**
 * Only an explicit permission refusal (403) means "this kind of session may not hold a local
 * key". Anything else (a timeout, a validation or app-version code, an unknown answer) is an
 * ordinary failure and fails closed: it never downgrades to the plaintext form.
 */
function isPermissionRefusal(err: unknown): boolean {
	return err instanceof ProtonApiError && err.status === 403;
}

/** Register a fresh client key for the session and seal the key password under it. */
export async function sealKeyPassword(
	transport: ProtonTransport,
	uid: string,
	keyPassword: KeyPassword,
	logger: BackendLogger,
): Promise<KeyPasswordAtRest> {
	const clientKey = crypto.getRandomValues(new Uint8Array(32));
	try {
		await transport.json("PUT", LOCAL_KEY_PATH, { Key: toBase64(clientKey) });
	} catch (err) {
		if (!isPermissionRefusal(err)) throw err;
		logger.warn("Proton refused a local key for this session; its key password is stored without that extra protection");
		return { keyPassword, keyPasswordAtRest: "plaintext" };
	}
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: additionalData(uid) },
		await aesKey(clientKey, "encrypt"),
		new TextEncoder().encode(keyPassword),
	);
	const blob = new Uint8Array(IV_LENGTH + sealed.byteLength);
	blob.set(iv);
	blob.set(new Uint8Array(sealed), IV_LENGTH);
	return { sealedKeyPassword: toBase64(blob) };
}

/** The key password of a stored session, unsealed in memory with the client key Proton holds. */
export async function keyPasswordOf(transport: ProtonTransport, session: StoredSession): Promise<KeyPassword> {
	if ("keyPassword" in session) return session.keyPassword;
	const reconnect = "The stored Proton Drive session can no longer be unlocked. Reconnect Proton Drive.";
	let response;
	try {
		response = await transport.json("GET", LOCAL_KEY_PATH);
	} catch (err) {
		// A 401 here survived a refresh: Proton no longer knows this session (revoked, signed
		// out elsewhere). Anything else keeps its ordinary classification (retry, update, …).
		if (err instanceof ProtonApiError && err.status === 401) failBackend("auth", reconnect);
		throw err;
	}
	if (typeof response.ClientKey !== "string" || response.ClientKey === "") failBackend("auth", reconnect);
	try {
		const blob = fromBase64(session.sealedKeyPassword);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: blob.subarray(0, IV_LENGTH), additionalData: additionalData(session.uid) },
			await aesKey(fromBase64(response.ClientKey), "decrypt"),
			blob.subarray(IV_LENGTH),
		);
		const keyPassword = parseKeyPassword(new TextDecoder().decode(plaintext));
		if (keyPassword) return keyPassword;
	} catch {
		// Wrong key, wrong session or a tampered blob: only a new sign-in helps.
	}
	return failBackend("auth", reconnect);
}
