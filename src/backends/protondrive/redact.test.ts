import { describe, expect, it } from "vitest";
import { sanitizeRoute } from "./redact";

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
