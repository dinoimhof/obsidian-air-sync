import { describe, expect, it } from "vitest";
import { sanitizeRoute, scrub, scrubbingLogger } from "./redact";

describe("sanitizeRoute", () => {
	it("drops the query and every non-route segment", () => {
		expect(sanitizeRoute("core/v4/keys/all?Email=jane%40example.org&InternalOnly=1")).toBe("core/v4/keys/all");
		expect(sanitizeRoute("auth/v4/sessions/forks/SEL")).toBe("auth/v4/sessions/forks/{id}");
		expect(sanitizeRoute("drive/v2/volumes/vol-AbC==/links/x~y")).toBe("drive/v2/volumes/{id}/links/{id}");
		expect(sanitizeRoute("auth/v4/refresh")).toBe("auth/v4/refresh");
		// A selector is opaque even when it looks like a route word.
		expect(sanitizeRoute("auth/v4/sessions/forks/abc123")).toBe("auth/v4/sessions/forks/{id}");
	});
});

describe("scrub", () => {
	it("removes emails, bearer values, fork selectors, query strings and credential fields", () => {
		const text = scrub(
			"GET https://drive-api.proton.me/auth/v4/sessions/forks/S3lect0r?x=1 for jane.doe@example.org " +
				"with Bearer abc.DEF-123 AccessToken=at-secret-value keyPassword: \"kp-secret\"",
		);
		for (const secret of ["S3lect0r", "x=1", "jane.doe@example.org", "abc.DEF-123", "at-secret-value", "kp-secret"]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain("forks/{id}");
		expect(text).toContain("[email]");
	});

	it("removes the storage upload token the SDK puts in block log prefixes", () => {
		expect(scrub("block 3:dXBsb2FkLXRva2Vu+/=: uploaded")).toBe("block 3:[redacted]: uploaded");
	});

	it("leaves an ordinary message and node uids intact", () => {
		expect(scrub("Proton Drive node changed before move")).toBe("Proton Drive node changed before move");
		expect(scrub("node uid: vol~link changed")).toBe("node uid: vol~link changed");
	});
});

describe("scrubbingLogger", () => {
	it("scrubs the message and nested context values", () => {
		const lines: Array<[string, unknown]> = [];
		const record = (message: string, context?: Record<string, unknown>) => void lines.push([message, context]);
		const logger = scrubbingLogger({ debug: record, info: record, warn: record, error: record });

		logger.warn("signed by jane@example.org", { error: "Bearer tok3n", nested: { refresh_token: "rt-value" } });

		expect(JSON.stringify(lines)).not.toMatch(/jane@example\.org|tok3n|rt-value/);
	});
});
