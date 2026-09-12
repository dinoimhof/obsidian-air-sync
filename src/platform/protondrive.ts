// SPDX-License-Identifier: GPL-3.0-or-later
// This file bundles @protontech/drive-sdk (GPL-3.0) into the distributed main.js;
// see docs/protondrive-backend.md for the licensing rationale. The rest of this
// project (see LICENSE) remains MIT and is unaffected.
import * as driveSdkRuntime from "@protontech/drive-sdk";
import { getRawCryptoProxyForSdk } from "./protondrive-crypto";

const runtimeValue: unknown = driveSdkRuntime;

function isCallable(value: unknown): value is new (...args: never[]) => unknown {
	return typeof value === "function";
}

function driveSdkMember(name: string): unknown {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("@protontech/drive-sdk runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>)[name];
	if (!candidate) throw new Error(`@protontech/drive-sdk ${name} export is unavailable`);
	return candidate;
}

function construct(name: string, args: unknown[]): unknown {
	const candidate = driveSdkMember(name);
	if (!isCallable(candidate)) throw new Error(`@protontech/drive-sdk ${name} is not a constructor`);
	return new candidate(...(args as never[]));
}

/**
 * The installed @protontech/drive-sdk version, required verbatim in the
 * `x-pm-drive-sdk-version` header on every Drive API request per Proton's
 * third-party operational guidelines.
 */
export function protonDriveSdkVersion(): string {
	const candidate = driveSdkMember("VERSION");
	if (typeof candidate !== "string") throw new Error("@protontech/drive-sdk VERSION export is unavailable");
	return candidate;
}

/**
 * A live `ProtonDriveClient` instance. Deliberately `unknown` at this boundary: Step 4
 * of this backend's implementation plan defines a first-party interface covering the
 * exact methods it calls (mirroring how `platform/obsidian.ts` hand-types `Vault`/
 * `App`/etc.), verified against real contract tests rather than transcribed blind here.
 */
export type ProtonDriveClientHandle = unknown;

/** Build the SDK's `MemoryCache` (used for both `entitiesCache` and `cryptoCache`). */
export function createProtonDriveMemoryCache(): unknown {
	return construct("MemoryCache", []);
}

/** Build the SDK's OpenPGP crypto adapter over the already-initialized `CryptoProxy`. */
export function createProtonDriveOpenPGPCrypto(): unknown {
	return construct("OpenPGPCryptoWithCryptoProxy", [getRawCryptoProxyForSdk()]);
}

/**
 * First-party mirror of the SDK's `ProtonDriveClientContructorParameters` field names
 * (see @protontech/drive-sdk's config.d.ts) — each value kept `unknown` since they're
 * themselves sourced from other unsafe-boundary-crossing constructors, but the field
 * names themselves are real, so a typo (e.g. `srpModule` misspelled) is still caught
 * at compile time instead of failing only at runtime.
 */
export interface ProtonDriveClientParams {
	httpClient: unknown;
	entitiesCache: unknown;
	cryptoCache: unknown;
	account: unknown;
	openPGPCryptoModule: unknown;
	srpModule: unknown;
	config: { clientUid: string };
}

/**
 * Construct the real `ProtonDriveClient`. Field values are forwarded to the SDK's
 * constructor as-is (not deeply validated) — the SDK itself is the authority on its
 * own constructor's shape; this boundary's job is only to isolate the untyped import,
 * not to re-implement the SDK's own validation.
 */
export function createProtonDriveClientInstance(params: ProtonDriveClientParams): ProtonDriveClientHandle {
	return construct("ProtonDriveClient", [params]);
}
