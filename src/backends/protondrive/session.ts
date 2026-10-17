import type { BackendSecretStore } from "../../backend-api";
import { failBackend } from "../shared/error-shape";

declare const sessionUidBrand: unique symbol;
declare const accessTokenBrand: unique symbol;
declare const refreshTokenBrand: unique symbol;
declare const keyPasswordBrand: unique symbol;

export type SessionUid = string & { readonly [sessionUidBrand]: true };
export type AccessToken = string & { readonly [accessTokenBrand]: true };
export type RefreshToken = string & { readonly [refreshTokenBrand]: true };
/** Passphrase for the account's user keys; decrypts every address key. */
export type KeyPassword = string & { readonly [keyPasswordBrand]: true };

export interface SessionTokens {
	readonly uid: SessionUid;
	readonly accessToken: AccessToken;
	readonly refreshToken: RefreshToken;
}

export interface ProtonSession extends SessionTokens {
	readonly keyPassword: KeyPassword;
}

/**
 * How the key password is kept at rest. Normally only its AES-GCM ciphertext, under a
 * client key Proton holds for this session (`auth/v4/sessions/local/key`, the pattern of
 * Proton's own web clients): a copied secret is useless once the session is revoked. The
 * plaintext form exists only, explicitly marked, when Proton refuses a local key.
 */
export type KeyPasswordAtRest =
	| { readonly sealedKeyPassword: string }
	| { readonly keyPassword: KeyPassword; readonly keyPasswordAtRest: "plaintext" };

/** What SecretStorage holds under {@link SESSION_SECRET_KEY}. */
export type StoredSession = SessionTokens & KeyPasswordAtRest;

/** The module's only credential key: one JSON-encoded {@link StoredSession}. */
export const SESSION_SECRET_KEY = "session";

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** `null` when any field is missing. */
export function parseSessionTokens(raw: {
	readonly UID?: unknown;
	readonly AccessToken?: unknown;
	readonly RefreshToken?: unknown;
}): SessionTokens | null {
	if (!nonEmpty(raw.UID) || !nonEmpty(raw.AccessToken) || !nonEmpty(raw.RefreshToken)) return null;
	return {
		uid: raw.UID as SessionUid,
		accessToken: raw.AccessToken as AccessToken,
		refreshToken: raw.RefreshToken as RefreshToken,
	};
}

export function parseKeyPassword(value: unknown): KeyPassword | null {
	return nonEmpty(value) ? (value as KeyPassword) : null;
}

function parseStoredSession(raw: string | null): StoredSession | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const tokens = parseSessionTokens({
		UID: record.uid,
		AccessToken: record.accessToken,
		RefreshToken: record.refreshToken,
	});
	if (!tokens) return null;
	if (nonEmpty(record.sealedKeyPassword)) return { ...tokens, sealedKeyPassword: record.sealedKeyPassword };
	// A plaintext key password counts only with its explicit marker. An unmarked one (the
	// shape before sealing existed) is treated as no session: reconnect once, no migration.
	const keyPassword = parseKeyPassword(record.keyPassword);
	if (keyPassword && record.keyPasswordAtRest === "plaintext") return { ...tokens, keyPassword, keyPasswordAtRest: "plaintext" };
	return null;
}

export async function saveSession(secrets: BackendSecretStore, session: StoredSession): Promise<void> {
	await secrets.set(SESSION_SECRET_KEY, JSON.stringify(session));
}

export async function loadSession(secrets: BackendSecretStore): Promise<StoredSession | null> {
	return parseStoredSession(await secrets.get(SESSION_SECRET_KEY));
}

/** `null` means Proton rejected the refresh token. */
export type TokenRefresher = (tokens: SessionTokens) => Promise<SessionTokens | null>;

/**
 * The live session of one connection. Refresh is single-flight and re-reads
 * SecretStorage first: another connection of this module may already have rotated
 * the refresh token, and Proton rejects a replayed one.
 */
export class SessionHandle {
	private inFlight: Promise<void> | null = null;

	private constructor(
		private readonly secrets: BackendSecretStore,
		private session: StoredSession,
		/** False only during sign-in, before the sealed session is first saved. */
		private readonly persist: boolean,
	) {}

	static async open(secrets: BackendSecretStore): Promise<SessionHandle> {
		const session = await loadSession(secrets);
		if (!session) failBackend("auth", "Not signed in to Proton Drive");
		return new SessionHandle(secrets, session, true);
	}

	/**
	 * The fresh session of a sign-in, used to register its local key before anything is
	 * stored. A refresh in that window stays in memory; the caller saves {@link tokens}.
	 */
	static forSignIn(secrets: BackendSecretStore, tokens: SessionTokens): SessionHandle {
		return new SessionHandle(secrets, { uid: tokens.uid, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, sealedKeyPassword: "" }, false);
	}

	get current(): StoredSession {
		return this.session;
	}

	get tokens(): SessionTokens {
		return { uid: this.session.uid, accessToken: this.session.accessToken, refreshToken: this.session.refreshToken };
	}

	/** Replace `rejected`'s tokens; throws an `auth` error when Proton refuses the refresh. */
	refresh(rejected: AccessToken, refresher: TokenRefresher): Promise<void> {
		if (this.session.accessToken !== rejected) return Promise.resolve();
		this.inFlight ??= this.performRefresh(rejected, refresher).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async performRefresh(rejected: AccessToken, refresher: TokenRefresher): Promise<void> {
		const stored = this.persist ? await loadSession(this.secrets) : null;
		if (stored && stored.accessToken !== rejected) {
			this.session = stored;
			return;
		}
		const tokens = await refresher(this.session);
		if (!tokens) failBackend("auth", "Proton Drive session expired. Please reconnect.");
		// New tokens, same key password at rest (sealed or marked plaintext).
		this.session = { ...this.session, uid: tokens.uid, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
		if (this.persist) await saveSession(this.secrets, this.session);
	}
}
