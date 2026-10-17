/**
 * Keeps credentials and personal data out of error messages, which end up in
 * `.airsync/logs/` inside the vault: messages are built from {@link sanitizeRoute}.
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
