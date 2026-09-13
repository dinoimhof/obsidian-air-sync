import type { ISecretStore } from "./secret-store";

/**
 * Obsidian's real `SecretStorage.setSecret(id, ...)` requires "Lowercase
 * alphanumeric ID with optional dashes" and throws otherwise (obsidian.d.ts).
 * No test double in this codebase enforces that constraint — a mock secret
 * store is a plain map that accepts any string key — so a camelCase `name`
 * (e.g. `"keyPassword"`) passes every unit test and only ever fails against
 * the real API, surfacing as the opaque "Secret credential could not be
 * saved securely" message with no indication the id itself was invalid. This
 * validates eagerly, outside that catch-all, so the mistake is caught at the
 * call site — in dev/tests, not silently deferred to a live connection
 * attempt against a real account.
 */
const VALID_SECRET_ID_SEGMENT = /^[a-z0-9-]+$/;

/**
 * Deterministic SecretStorage key for a backend secret.
 *
 * The format is intentionally stable (`air-sync-<type>-<name>-token`) so that
 * secrets stored by earlier versions survive this generalization — existing
 * users do not need to reconnect.
 */
function secretKey(backendType: string, name: string): string {
	if (!VALID_SECRET_ID_SEGMENT.test(backendType) || !VALID_SECRET_ID_SEGMENT.test(name)) {
		throw new Error(
			`Invalid backend secret id segment: backendType="${backendType}" name="${name}" ` +
				"— Obsidian's SecretStorage requires lowercase alphanumeric with only dashes " +
				"(use \"key-password\", not \"keyPassword\").",
		);
	}
	return `air-sync-${backendType}-${name}-token`;
}

/**
 * Store an opaque secret for a backend under the given name.
 *
 * Empty values are skipped (a backend may not have every secret, e.g. pCloud
 * has no refresh token). Use {@link clearBackendSecrets} to remove a secret.
 */
export function setBackendSecret(store: ISecretStore, backendType: string, name: string, value: string): void {
	if (value) {
		store.setSecret(secretKey(backendType, name), value);
	}
}

/**
 * Publish a required non-empty backend secret and prove the synchronous
 * SecretStorage postcondition before the caller exposes dependent state.
 *
 * Obsidian's API is synchronous but does not promise OS-level flush semantics.
 * This check therefore proves only the boundary the API exposes: immediate,
 * exact readback of the candidate under the stable backend key.
 */
export function publishBackendSecret(
	store: ISecretStore,
	backendType: string,
	name: string,
	candidate: string,
): void {
	if (!candidate) {
		throw new Error("Required refresh token is missing");
	}
	// Computed OUTSIDE the try block: an invalid id is a programming error (see
	// secretKey's own guard), not a runtime storage failure — it must surface with
	// its own specific message, never get swallowed into the generic one below.
	const key = secretKey(backendType, name);
	try {
		store.setSecret(key, candidate);
		if (store.getSecret(key) !== candidate) {
			throw new Error("readback mismatch");
		}
	} catch {
		throw new Error("Secret credential could not be saved securely. Please try connecting again.");
	}
}

/** Read an opaque backend secret, or `""` if absent. */
export function getBackendSecret(store: ISecretStore, backendType: string, name: string): string {
	return store.getSecret(secretKey(backendType, name)) ?? "";
}

/** Whether a backend secret of the given name is present. */
export function hasBackendSecret(store: ISecretStore, backendType: string, name: string): boolean {
	return !!store.getSecret(secretKey(backendType, name));
}

/** Clear the named backend secrets. */
export function clearBackendSecrets(store: ISecretStore, backendType: string, names: string[]): void {
	for (const name of names) {
		store.setSecret(secretKey(backendType, name), "");
	}
}
