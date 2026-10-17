import type { BackendErrorShape } from "../../backend-api";
import { backendError, isBackendErrorShape } from "../../backend-api";
import { backendErrorFromStatus } from "../shared/error-shape";
import { ProtonApiError } from "./transport";
import { scrub } from "./redact";

/** Proton API body codes the taxonomy distinguishes. */
const ALREADY_EXISTS = 2500;
const NOT_EXISTS = 2501;
const NOT_ENOUGH_PERMISSIONS = 2011;
const HUMAN_VERIFICATION_REQUIRED = 9001;
/** Proton's OpenAPI types: "You need to update this app in order to perform this operation". */
const APP_UPDATE_REQUIRED = 5003;
const INSUFFICIENT_QUOTA_CODES: ReadonlySet<number> = new Set([200001, 200002, 200003, 200100]);

function numberField(err: object, key: string): number | undefined {
	const value = (err as Record<string, unknown>)[key];
	return typeof value === "number" ? value : undefined;
}

function fromCode(code: number | undefined, message: string): BackendErrorShape | null {
	switch (code) {
		case undefined:
			return null;
		case ALREADY_EXISTS:
			return backendError("target_changed", message);
		case NOT_EXISTS:
			return backendError("not_found", message);
		case NOT_ENOUGH_PERMISSIONS:
			return backendError("permission", message);
		case APP_UPDATE_REQUIRED:
			// Proton retires old clients (e.g. after its crypto-model change): retrying cannot help.
			return backendError("permanent", "Proton requires a newer version of Air Sync. Update the plugin, then sync again.", {
				permanentCode: "protondrive:app-update-required",
			});
		case HUMAN_VERIFICATION_REQUIRED:
			return backendError("permanent", "Proton requires human verification. Sign in at drive.proton.me, then sync again.", {
				permanentCode: "protondrive:human-verification",
			});
		default:
			return INSUFFICIENT_QUOTA_CODES.has(code)
				? backendError("permanent", message, { permanentCode: "protondrive:quota" })
				: null;
	}
}

/** SDK errors are matched by `name`, so this file does not load the SDK runtime. */
/** Severity order for a classified error the SDK wrapped as a cause: the one to act on first. */
const CAUSE_PRECEDENCE: readonly BackendErrorShape["kind"][] = ["auth", "permission", "permanent", "unverifiable", "rate_limit"];

/**
 * The SDK collects per-node failures (including a classified error our own account code
 * threw) into `ProtonDriveError({ cause: errors })`. Return the most severe classified
 * cause, so an auth error is not reduced to "transient" on paths that batch nodes.
 */
function classifiedCause(err: object): BackendErrorShape | null {
	const raw = (err as { cause?: unknown }).cause;
	const causes = (Array.isArray(raw) ? raw : [raw]).filter(isBackendErrorShape);
	for (const kind of CAUSE_PRECEDENCE) {
		const match = causes.find((cause) => cause.kind === kind);
		if (match) return match;
	}
	return causes[0] ?? null;
}

export function translateProtonError(err: unknown): BackendErrorShape {
	if (isBackendErrorShape(err)) return err;
	if (typeof err === "object" && err !== null) {
		const cause = classifiedCause(err);
		if (cause) return cause;
	}
	// SDK messages are not ours to vet: scrub them before they become a logged message.
	const message = err instanceof Error ? scrub(err.message) : "Proton Drive request failed";
	if (err instanceof ProtonApiError) {
		return fromCode(err.code, message) ?? backendErrorFromStatus(err.status, message, undefined, err.retryAfterMs);
	}
	if (typeof err !== "object" || err === null) return backendError("transient", message);
	const name = err instanceof Error ? err.name : "";
	const code = numberField(err, "code");
	switch (name) {
		case "NodeWithSameNameExistsValidationError":
			return backendError("target_changed", message);
		case "NotFoundAPIError":
			return backendError("not_found", message);
		case "RateLimitedError":
			return backendError("rate_limit", message);
		case "AbortError":
		case "TimeoutError":
		case "ConnectionError":
		case "OfflineError":
			return backendError("transient", message);
		case "IntegrityError":
			return backendError("transient", `Proton Drive integrity check failed: ${message}`);
		case "DecryptionError":
			return backendError("unverifiable", message);
		case "ValidationError":
		case "InvalidRequirementsAPIError":
			return fromCode(code, message) ?? backendError("permanent", message, { permanentCode: `protondrive:${code ?? "validation"}` });
		case "APIHTTPError":
			return backendErrorFromStatus(numberField(err, "statusCode") ?? 0, message);
		case "APICodeError":
		case "ServerError":
			return fromCode(code, message) ?? backendError("transient", message);
		default:
			return backendError("transient", message);
	}
}
