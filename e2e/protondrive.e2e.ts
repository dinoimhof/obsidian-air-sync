// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe } from "vitest";
import { ProtonDriveAuth } from "../src/fs/protondrive/auth";
import { createProtonDriveClient } from "../src/fs/protondrive/client";
import { ProtonDriveClient, type ProtonDriveNode } from "../src/fs/protondrive/drive-client";
import { ProtonDriveFs } from "../src/fs/protondrive/index";
import { runIFileSystemContract } from "../tests/fs/contracts/ifilesystem.contract";
import { MetadataStore } from "../src/store/metadata-store";
import { loadDotEnvE2e } from "./helpers/env";
import {
	cleanupProtonDriveParent,
	makeProtonDriveChild,
	makeProtonDriveParent,
} from "./helpers/isolation";
import { runRenameSafetyE2E } from "./helpers/rename-safety";
import { runPriorityFidelityE2E } from "./helpers/priority-fidelity";

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Proton Drive API, to catch
 * drift between the fake `ProtonDriveClient` (`tests/fs/protondrive/`) and the
 * real SDK-backed one.
 *
 * Unlike the OAuth backends, Proton's session-fork login carries no single
 * refresh token — `uid` and `keyPassword` are both load-bearing per-session
 * state (see docs/protondrive-backend.md and ADR 0003's point 10 amendment), so
 * this reads four env vars rather than one. Skips (with a warning, never
 * failing) when any is absent. Get them via `npm run e2e:bootstrap --
 * protondrive`. See docs/e2e-testing.md.
 */
loadDotEnvE2e();
const uid = process.env.AIRSYNC_E2E_PROTONDRIVE_UID;
const refreshToken = process.env.AIRSYNC_E2E_PROTONDRIVE_REFRESH_TOKEN;
const accessToken = process.env.AIRSYNC_E2E_PROTONDRIVE_ACCESS_TOKEN;
const keyPassword = process.env.AIRSYNC_E2E_PROTONDRIVE_KEY_PASSWORD;

if (!uid || !refreshToken || !accessToken || !keyPassword) {
	console.warn(
		"[e2e] Skipping Proton Drive: set AIRSYNC_E2E_PROTONDRIVE_UID/_REFRESH_TOKEN/" +
			"_ACCESS_TOKEN/_KEY_PASSWORD (run `npm run e2e:bootstrap -- protondrive`; " +
			"see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — ProtonDriveFs (real) [no creds]", () => {
		/* skipped */
	});
} else {
	const auth = new ProtonDriveAuth();
	// Real freshness is enforced reactively (a 401 triggers one forced
	// refresh-and-retry — see ProtonApiClient), so a stale bootstrapped access
	// token self-heals on first use even if this run happens long after the
	// bootstrap; restoreSession never needs to know the token's true age.
	auth.restoreSession({ uid, refreshToken, accessToken, keyPassword });
	// A fresh per-run tag is fine for e2e — clientUid only needs to be stable
	// across ONE installation's real sessions (see provider.ts), not across runs.
	const client = new ProtonDriveClient(createProtonDriveClient(auth, crypto.randomUUID()));
	let parentUid = "";

	beforeAll(async () => {
		parentUid = await makeProtonDriveParent(client);
	});
	afterAll(async () => {
		// Best-effort: a cleanup failure must not fail an otherwise-green run.
		if (!parentUid) return;
		try {
			await cleanupProtonDriveParent(client, parentUid);
		} catch (err) {
			console.warn(
				`[e2e] Proton Drive cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	runIFileSystemContract(
		"ProtonDriveFs (real)",
		async () => new ProtonDriveFs(client, await makeProtonDriveChild(client, parentUid)),
		// preservesWrittenMtime/mtimePrecisionMs are left at the exact default
		// (unverified live, per ADR 0003 point 8's own precedent): the SDK's
		// UploadMetadata.modificationTime takes a millisecond Date, but whether
		// Proton Drive's server preserves that exactly is only provable by this
		// run. If it goes red on mtime, that failure is the real, empirical
		// answer — relax it here with the same knob OneDrive needed, not before.
		{ computesHashOnStat: false, stableIdentity: true },
	);

	runPriorityFidelityE2E(
		"ProtonDriveFs",
		async () => new ProtonDriveFs(client, await makeProtonDriveChild(client, parentUid)),
	);

	runRenameSafetyE2E("ProtonDriveFs", {
		backendType: "protondrive",
		makeBackend: async () => {
			const childUid = await makeProtonDriveChild(client, parentUid);
			const store = new MetadataStore<ProtonDriveNode>(crypto.randomUUID(), {
				dbNamePrefix: "air-sync-protondrive-e2e-rename",
				version: 1,
			});
			const fs = new ProtonDriveFs(client, childUid, undefined, store);
			return {
				fs,
				renameOutOfBand: async (file, newPath) => {
					// A single SDK renameNode call handles a case-only rename directly
					// (unlike Dropbox's two-hop temp-name dance).
					await client.move(file.identityKey!, newPath, undefined);
				},
			};
		},
	});
}
