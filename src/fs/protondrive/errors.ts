// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import { AuthError, classifyHttpError } from "../errors";
import type { ErrorClassification } from "../errors";

/**
 * Classify an error thrown by `@protontech/drive-sdk`. Unlike the other backends,
 * the SDK's own thrown errors are not HTTP-status objects (`{status}`) — they are
 * named error classes (`ServerError`/`RateLimitedError`/`ConnectionError`/…, see
 * `@protontech/drive-sdk`'s `errors.ts`) matched here structurally by `.name`, the
 * same technique already used by `isProtonDriveNotFoundError` in
 * `platform/protondrive.ts` (avoiding a value import of the untyped-simulated SDK
 * package outside `src/platform/`). `ServerError.statusCode` carries the HTTP
 * status when the SDK has one, so those map through the same status → kind table
 * as every other backend; everything else (transport-layer `requestUrl` failures,
 * e.g. from `fork-auth.ts`/`api-client.ts`) falls back to {@link classifyHttpError}.
 */
export function classifyProtonDriveError(err: unknown): ErrorClassification {
	if (err instanceof AuthError) return { kind: "auth" };
	if (typeof err !== "object" || err === null) return classifyHttpError(err);

	const rec = err as Record<string, unknown>;
	if (rec.name === "RateLimitedError") return { kind: "rateLimit" };
	if (rec.name === "ServerError") {
		const status = typeof rec.statusCode === "number" ? rec.statusCode : undefined;
		if (status === 401) return { kind: "auth" };
		if (status === 403) return { kind: "permission" };
		if (status === 404) return { kind: "notFound" };
		if (status === 429) return { kind: "rateLimit" };
		return { kind: "transient" };
	}
	if (rec.name === "ConnectionError") return { kind: "transient" };
	return classifyHttpError(err);
}
