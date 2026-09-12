// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend, which bundles @protontech/crypto
// (GPL-3.0) into the distributed main.js; see docs/protondrive-backend.md for the
// licensing rationale. The rest of this project (see LICENSE) remains MIT.

import { requestUrl } from "../../platform/obsidian";
import { PROTON_DRIVE_AUTH } from "../auth-config";

/**
 * Proton's session-fork login: the plugin never collects a password. It initiates a
 * fork, opens Proton's own account.proton.me login in the system browser with a
 * locally-generated AES key embedded only in the URL fragment (never sent to any
 * server), then polls for the fork to resolve. Verified end to end against a live
 * account (see docs/protondrive-backend.md) using only native fetch/Web Crypto; this
 * is the same logic ported to `requestUrl()` for the real plugin.
 */

const FORK_AAD = new TextEncoder().encode("fork");
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

export const FORK_POLL_INTERVAL_MS = 5000;
export const FORK_INITIAL_DELAY_MS = 5000;
export const FORK_MAX_POLL_TIME_MS = 10 * 60 * 1000;

export interface SessionForkInitResponse {
	Code: number;
	Selector: string;
	UserCode: string;
}

export interface SessionForkStatusResponse {
	Code: number;
	Payload: string;
	UID: string;
	AccessToken: string;
	RefreshToken?: string;
}

export interface ForkNotReady {
	notReady: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertSessionForkInitResponse(value: unknown): asserts value is SessionForkInitResponse {
	if (
		!isRecord(value)
		|| typeof value.Selector !== "string" || !value.Selector
		|| typeof value.UserCode !== "string" || !value.UserCode
	) {
		throw new Error("Proton session fork returned an invalid init response");
	}
}

function assertSessionForkStatusResponse(value: unknown): asserts value is SessionForkStatusResponse {
	if (
		!isRecord(value)
		|| typeof value.Payload !== "string" || !value.Payload
		|| typeof value.UID !== "string" || !value.UID
		|| typeof value.AccessToken !== "string" || !value.AccessToken
		|| (value.RefreshToken !== undefined && typeof value.RefreshToken !== "string")
	) {
		throw new Error("Proton session fork returned an invalid status response");
	}
}

/** Initiate a session fork. Unauthenticated — no session exists yet. */
export async function sessionForksInit(): Promise<SessionForkInitResponse> {
	const res = await requestUrl({
		url: `${PROTON_DRIVE_AUTH.apiBaseUrl}/auth/v4/sessions/forks`,
		method: "GET",
		throw: false,
		headers: { "x-pm-appversion": PROTON_DRIVE_AUTH.appVersion },
	});
	if (res.status !== 200) {
		throw new Error(`Proton session fork could not be started (${res.status})`);
	}
	assertSessionForkInitResponse(res.json);
	return res.json;
}

/**
 * Poll a fork's status. A 422 means the user hasn't finished signing in yet — the
 * caller treats that as "not ready" and polls again, per Proton's documented flow.
 */
export async function sessionForksStatus(selector: string): Promise<SessionForkStatusResponse | ForkNotReady> {
	const res = await requestUrl({
		url: `${PROTON_DRIVE_AUTH.apiBaseUrl}/auth/v4/sessions/forks/${encodeURIComponent(selector)}`,
		method: "GET",
		throw: false,
		headers: { "x-pm-appversion": PROTON_DRIVE_AUTH.appVersion },
	});
	if (res.status === 422) return { notReady: true };
	if (res.status !== 200) {
		throw new Error(`Proton session fork status check failed (${res.status})`);
	}
	assertSessionForkStatusResponse(res.json);
	return res.json;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Generate the fork's local AES key and the sign-in URL to open in the browser. The
 * key lives only in the URL fragment (`#payload=…`), never transmitted to any server —
 * Proton's login page reads it client-side to encrypt the fork payload, and only this
 * same key (held only by this plugin instance) can later decrypt it.
 */
export function generateForkSignInUrl(userCode: string): { encryptionKey: Uint8Array; signInUrl: string } {
	const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
	const payload = `0:${userCode}:${uint8ArrayToBase64(encryptionKey)}:${PROTON_DRIVE_AUTH.authClientId}`;
	const signInUrl = `${PROTON_DRIVE_AUTH.accountUrl}/desktop/login?app=drive&pv=3#payload=${encodeURIComponent(payload)}`;
	return { encryptionKey, signInUrl };
}

/** Decrypt a resolved fork's payload (AES-256-GCM) into its `keyPassword`. */
export async function decryptForkKeyPassword(encryptionKey: Uint8Array, encodedPayload: string): Promise<string> {
	const blob = base64ToUint8Array(encodedPayload);
	if (blob.length < GCM_NONCE_LENGTH + GCM_TAG_LENGTH) {
		throw new Error("Proton session fork returned a malformed payload");
	}
	// Uint8Array.from(...) rematerializes a guaranteed ArrayBuffer-backed copy: .subarray()
	// and a bare `Uint8Array` parameter both type as `Uint8Array<ArrayBufferLike>`, which
	// WebCrypto's BufferSource parameters (ArrayBuffer-only) reject.
	const nonce = Uint8Array.from(blob.subarray(0, GCM_NONCE_LENGTH));
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(encryptionKey),
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: FORK_AAD, tagLength: GCM_TAG_LENGTH * 8 },
		cryptoKey,
		Uint8Array.from(blob.subarray(GCM_NONCE_LENGTH)),
	);
	const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
	if (!isRecord(parsed) || typeof parsed.keyPassword !== "string" || !parsed.keyPassword) {
		throw new Error("Proton session fork payload did not contain a key password");
	}
	return parsed.keyPassword;
}
