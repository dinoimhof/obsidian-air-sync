import type { BackendLogger } from "../../backend-api";

/**
 * Keeps credentials and personal data out of error messages and logs, which end up in
 * `.airsync/logs/` inside the vault. Two layers: messages are built from
 * {@link sanitizeRoute} at the source, and {@link scrub} runs at the logger boundary
 * (module and SDK messages) in case a value slipped through, e.g. from a future SDK.
 */

/**
 * Route words in Proton's API are short lowercase words (`core`, `v4`, `forks`). Anything
 * else (an id, a selector, an encoded value, an email) is opaque. An allowlist, so new
 * routes and new id shapes are covered without a template list.
 */
function isOpaqueSegment(segment: string): boolean {
	return segment !== "" && !/^[a-z][a-z0-9_-]{0,19}$/.test(segment);
}

/** `core/v4/keys/all?Email=x` → `core/v4/keys/all`; `auth/v4/sessions/forks/<selector>` → `…/forks/{id}`. */
export function sanitizeRoute(path: string): string {
	const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
	const segments = withoutQuery.split("/");
	// The fork selector releases session tokens until consumed: always opaque, whatever its shape.
	return segments
		.map((segment, i) => (isOpaqueSegment(segment) || (i > 0 && segments[i - 1] === "forks") ? "{id}" : segment))
		.join("/");
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const FORK_SELECTOR = /(sessions\/forks\/)[^\s/?#"')]+/gi;
const QUERY = /(\?)[^\s"')]+/g;
const CREDENTIAL_FIELD =
	/\b(access[_-]?token|refresh[_-]?token|key[_-]?password|selector|payload|x-pm-uid|pm-storage-token|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

/** Remove emails, bearer values, fork selectors, query strings and credential fields. */
export function scrub(text: string): string {
	return text
		.replace(BEARER, "$1[redacted]")
		.replace(FORK_SELECTOR, "$1{id}")
		.replace(CREDENTIAL_FIELD, "$1$2[redacted]")
		.replace(QUERY, "$1[query]")
		.replace(EMAIL, "[email]");
}

const CREDENTIAL_KEY =
	/^(access[_-]?token|refresh[_-]?token|key[_-]?password|selector|payload|x-pm-uid|session|token|secret|password|authorization|email)$/i;

function scrubValue(value: unknown): unknown {
	if (typeof value === "string") return scrub(value);
	if (Array.isArray(value)) return value.map(scrubValue);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, CREDENTIAL_KEY.test(key) ? "[redacted]" : scrubValue(entry)]),
		);
	}
	return value;
}

/** A logger that scrubs every message and context value before it reaches `logger`. */
export function scrubbingLogger(logger: BackendLogger): BackendLogger {
	const wrap = (level: keyof BackendLogger) => (message: string, context?: Record<string, unknown>): void => {
		logger[level](scrub(message), context === undefined ? undefined : (scrubValue(context) as Record<string, unknown>));
	};
	return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}
