// SPDX-License-Identifier: GPL-3.0-or-later
// This file bundles @protontech/drive-sdk and @protontech/crypto (GPL-3.0) into the
// distributed main.js; see docs/protondrive-backend.md for the licensing rationale.
// The rest of this project (see LICENSE) remains MIT.

import type { Logger } from "../../logging/logger";
import {
	createProtonDriveClientInstance,
	createProtonDriveMemoryCache,
	createProtonDriveOpenPGPCrypto,
	type ProtonDriveClientHandle,
} from "../../platform/protondrive";
import { initProtonDriveCrypto } from "../../platform/protondrive-crypto";
import { ProtonAccountApi } from "./account-api";
import { ProtonApiClient } from "./api-client";
import type { ProtonDriveAuth } from "./auth";
import { ProtonDriveAddresses } from "./addresses";
import { ProtonDriveHttpClient } from "./http-client";
import { ProtonSrp } from "./srp";

/**
 * Build a fully-wired `ProtonDriveClient` for one logged-in session: an authenticated
 * HTTP transport (`requestUrl()`-backed, never `fetch`), the account/key-decryption
 * layer, the crypto endpoint, and the (unused but required) SRP module. Verified
 * working end to end against a live account in this backend's spike before being
 * ported here — see docs/protondrive-backend.md.
 *
 * `clientUid` is a stable, per-*installation* identifier Proton uses to track this
 * client across sessions — unrelated to (and far longer-lived than) the session's own
 * `x-pm-uid`. Generating and persisting it is the caller's responsibility (it belongs
 * with the rest of this backend's settings/provider wiring, not this stateless
 * factory); pass the same value across logins on one installation.
 *
 * Call once per session (after a successful login or on rehydration); the returned
 * client holds no reference to anything beyond what `auth` already exposes, so it is
 * safe to drop and recreate if the caller's own session/auth instance changes.
 */
export function createProtonDriveClient(
	auth: ProtonDriveAuth,
	clientUid: string,
	logger?: Logger,
): ProtonDriveClientHandle {
	const apiClient = new ProtonApiClient(auth, logger);
	const accountApi = new ProtonAccountApi(apiClient);
	initProtonDriveCrypto();

	return createProtonDriveClientInstance({
		httpClient: new ProtonDriveHttpClient(apiClient),
		entitiesCache: createProtonDriveMemoryCache(),
		cryptoCache: createProtonDriveMemoryCache(),
		account: new ProtonDriveAddresses(accountApi, auth),
		openPGPCryptoModule: createProtonDriveOpenPGPCrypto(),
		srpModule: new ProtonSrp(accountApi),
		config: { clientUid },
	});
}
