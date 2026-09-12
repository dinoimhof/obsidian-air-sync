// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend, which bundles @protontech/crypto
// (GPL-3.0) into the distributed main.js; see docs/protondrive-backend.md for the
// licensing rationale. The rest of this project (see LICENSE) remains MIT.

import { Notice, Platform, requestUrl } from "../../platform/obsidian";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { Logger } from "../../logging/logger";
import { AuthError } from "../errors";
import { BaseOAuthTokenManager } from "../oauth-pkce";
import { getBackendSecret, hasBackendSecret, publishBackendSecret, setBackendSecret } from "../token-store";
import { PROTON_DRIVE_AUTH } from "../auth-config";
import {
	decryptForkKeyPassword,
	FORK_INITIAL_DELAY_MS,
	FORK_MAX_POLL_TIME_MS,
	FORK_POLL_INTERVAL_MS,
	generateForkSignInUrl,
	sessionForksInit,
	sessionForksStatus,
} from "./fork-auth";

export const PROTON_DRIVE_BACKEND_TYPE = "protondrive";

/**
 * Proton's refresh endpoint carries no expiry — unlike Dropbox/OneDrive/Google, whose
 * OAuth responses say exactly how long an access token is good for. Real freshness is
 * enforced reactively, the same way every backend in this codebase already handles a
 * 401 (one forced refresh-and-retry) — this assumed lifetime only controls how often a
 * proactive, otherwise-unnecessary refresh happens absent a real 401.
 */
const ASSUMED_ACCESS_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface ProtonRefreshResponse {
	UID?: string;
	AccessToken: string;
	RefreshToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertRefreshResponse(value: unknown): asserts value is ProtonRefreshResponse {
	if (
		!isRecord(value)
		|| typeof value.AccessToken !== "string" || !value.AccessToken
		|| (value.UID !== undefined && typeof value.UID !== "string")
		|| (value.RefreshToken !== undefined && typeof value.RefreshToken !== "string")
	) {
		throw new Error("Proton session refresh returned an invalid response");
	}
}

export interface ProtonSessionForkResult {
	uid: string;
	accessToken: string;
	refreshToken?: string;
	keyPassword: string;
}

export interface ProtonStoredSession {
	uid: string;
	refreshToken: string;
	accessToken: string;
	keyPassword: string;
}

/**
 * Proton Drive session/token manager. The access/refresh lifecycle (skew-based reuse,
 * concurrent-refresh dedup, post-failure cooldown, rotation hook) is inherited from
 * {@link BaseOAuthTokenManager}, same as every OAuth backend; this class supplies
 * Proton's own wire protocol plus the two fields no OAuth backend needs: the session
 * `uid` (required as `x-pm-uid` on every authenticated call) and `keyPassword` (unlocks
 * the account's private keys — see docs/protondrive-backend.md). Neither is persisted
 * by this class; the provider publishes them to `ISecretStore` alongside the tokens.
 */
export class ProtonDriveAuth extends BaseOAuthTokenManager {
	private uid = "";
	private keyPassword = "";

	constructor(logger?: Logger) {
		super();
		this.logger = logger;
	}

	protected notAuthenticatedMessage(): string {
		return "Not authenticated. Please connect to Proton Drive first.";
	}

	protected sessionExpiredMessage(): string {
		return "Proton Drive session expired. Please reconnect in settings.";
	}

	getUid(): string {
		return this.uid;
	}

	getKeyPassword(): string {
		return this.keyPassword;
	}

	/** Install a freshly resolved session-fork result (a brand-new login). */
	async applyForkResult(result: ProtonSessionForkResult): Promise<void> {
		this.uid = result.uid;
		this.keyPassword = result.keyPassword;
		await this.storeTokenResponse({
			access_token: result.accessToken,
			refresh_token: result.refreshToken,
			expires_in: ASSUMED_ACCESS_TOKEN_LIFETIME_MS / 1000,
		});
	}

	/** Rehydrate a session persisted in a previous plugin load — no user action needed. */
	restoreSession(session: ProtonStoredSession): void {
		this.uid = session.uid;
		this.keyPassword = session.keyPassword;
		this.setTokens(session.refreshToken, session.accessToken, Date.now() + ASSUMED_ACCESS_TOKEN_LIFETIME_MS);
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing Proton Drive session");
		const res = await requestUrl({
			url: `${PROTON_DRIVE_AUTH.apiBaseUrl}/auth/v4/refresh`,
			method: "POST",
			throw: false,
			headers: { "x-pm-appversion": PROTON_DRIVE_AUTH.appVersion, "Content-Type": "application/json" },
			body: JSON.stringify({ ResponseType: "token", GrantType: "refresh_token", RefreshToken: this.refreshToken }),
		});
		if (res.status === 400 || res.status === 401) {
			this.authFailedAt = Date.now();
			throw new AuthError(`Proton Drive session refresh failed (${res.status})`, res.status);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Proton Drive session refresh failed (${res.status})`);
		}
		assertRefreshResponse(res.json);
		if (res.json.UID) this.uid = res.json.UID;
		await this.storeTokenResponse({
			access_token: res.json.AccessToken,
			refresh_token: res.json.RefreshToken,
			expires_in: ASSUMED_ACCESS_TOKEN_LIFETIME_MS / 1000,
		});
		return this.accessToken;
	}
}

export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Proton Drive authentication provider. Unlike every OAuth backend, the entire login
 * happens inside {@link startAuth}: it opens the session-fork sign-in URL and polls
 * in-process until the user finishes signing in on Proton's own origin (see
 * docs/protondrive-backend.md) — there is no `obsidian://air-sync-auth` callback step
 * at all, so {@link completeAuth} is never invoked by the existing orchestration and
 * throws if it ever is. `sleep` is injectable (default: real timers) so tests can run
 * the poll loop instantly, matching DropboxClient's own retry-backoff pattern.
 */
export class ProtonDriveAuthProvider implements IAuthProvider {
	private auth: ProtonDriveAuth | null = null;

	constructor(
		private secretStore: ISecretStore,
		private logger?: Logger,
		private sleep: SleepFn = defaultSleep,
	) {}

	/** Get or lazily rehydrate the shared token manager — no user action needed. */
	getOrCreateAuth(): ProtonDriveAuth {
		if (this.auth) return this.auth;
		const auth = new ProtonDriveAuth(this.logger);
		auth.setRefreshTokenRotatedHook((refreshToken) => {
			publishBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "refresh", refreshToken);
		});
		const refreshToken = getBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "refresh");
		if (refreshToken) {
			auth.restoreSession({
				uid: getBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "uid"),
				refreshToken,
				accessToken: getBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "access"),
				keyPassword: getBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "keyPassword"),
			});
		}
		this.auth = auth;
		return auth;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return (
			hasBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "refresh")
			&& hasBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "keyPassword")
		);
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const init = await sessionForksInit();
		const { encryptionKey, signInUrl } = generateForkSignInUrl(init.UserCode);
		if (Platform.isMobile) {
			window.location.href = signInUrl;
		} else {
			window.open(signInUrl);
		}
		new Notice("Proton sign-in opened in your browser — complete it there to continue");

		await this.sleep(FORK_INITIAL_DELAY_MS);
		const startTime = Date.now();
		while (true) {
			if (Date.now() - startTime > FORK_MAX_POLL_TIME_MS) {
				throw new AuthError("Proton Drive sign-in timed out. Please try connecting again.", 408);
			}
			const status = await sessionForksStatus(init.Selector);
			if ("notReady" in status) {
				await this.sleep(FORK_POLL_INTERVAL_MS);
				continue;
			}

			const keyPassword = await decryptForkKeyPassword(encryptionKey, status.Payload);
			const auth = this.getOrCreateAuth();
			await auth.applyForkResult({
				uid: status.UID,
				accessToken: status.AccessToken,
				refreshToken: status.RefreshToken,
				keyPassword,
			});
			const tokens = auth.getTokenState();
			publishBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "refresh", tokens.refreshToken);
			setBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "access", tokens.accessToken);
			publishBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "uid", auth.getUid());
			publishBackendSecret(this.secretStore, PROTON_DRIVE_BACKEND_TYPE, "keyPassword", auth.getKeyPassword());
			return { accessTokenExpiry: tokens.accessTokenExpiry };
		}
	}

	completeAuth(_input: string, _backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		throw new Error("Proton Drive authentication completes synchronously in startAuth(); completeAuth is never called.");
	}

	/** Drop the in-memory session. Proton exposes no client-callable revoke endpoint. */
	revokeAuth(): void {
		this.auth = null;
	}
}
