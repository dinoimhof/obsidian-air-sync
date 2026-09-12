// SPDX-License-Identifier: GPL-3.0-or-later
// This file bundles @protontech/drive-sdk (GPL-3.0) into the distributed main.js;
// see docs/protondrive-backend.md for the licensing rationale. The rest of this
// project (see LICENSE) remains MIT and is unaffected.
import * as driveSdkRuntime from "@protontech/drive-sdk";

const runtimeValue: unknown = driveSdkRuntime;

/**
 * The installed @protontech/drive-sdk version, required verbatim in the
 * `x-pm-drive-sdk-version` header on every Drive API request per Proton's
 * third-party operational guidelines.
 */
export function protonDriveSdkVersion(): string {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("@protontech/drive-sdk runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>).VERSION;
	if (typeof candidate !== "string") throw new Error("@protontech/drive-sdk VERSION export is unavailable");
	return candidate;
}
