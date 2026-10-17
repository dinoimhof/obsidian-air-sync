import { describe, expect, it } from "vitest";
import { translateProtonError } from "./errors";
import { ProtonApiError } from "./transport";

const sdk = (name: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(name), { name }, fields);

describe("translateProtonError mapping table", () => {
	it.each([
		["same name exists", sdk("NodeWithSameNameExistsValidationError"), "target_changed"],
		["not found", sdk("NotFoundAPIError"), "not_found"],
		["rate limited", sdk("RateLimitedError"), "rate_limit"],
		["aborted", sdk("AbortError"), "transient"],
		["timed out", sdk("TimeoutError"), "transient"],
		["connection", sdk("ConnectionError"), "transient"],
		["offline", sdk("OfflineError"), "transient"],
		["integrity", sdk("IntegrityError"), "transient"],
		["decryption", sdk("DecryptionError"), "unverifiable"],
		["validation without code", sdk("ValidationError"), "permanent"],
		["invalid requirements", sdk("InvalidRequirementsAPIError", { code: 2001 }), "permanent"],
		["HTTP 404", sdk("APIHTTPError", { statusCode: 404 }), "not_found"],
		["HTTP 503", sdk("APIHTTPError", { statusCode: 503 }), "transient"],
		["server error", sdk("ServerError"), "transient"],
		["API code already exists", sdk("APICodeError", { code: 2500 }), "target_changed"],
		["API code not exists", sdk("APICodeError", { code: 2501 }), "not_found"],
		["API code no permission", sdk("APICodeError", { code: 2011 }), "permission"],
		["API code human verification", sdk("APICodeError", { code: 9001 }), "permanent"],
		["transport 401", new ProtonApiError(401, undefined, "x"), "auth"],
		["transport 403", new ProtonApiError(403, undefined, "x"), "permission"],
		["a string", "boom", "transient"],
	] as const)("%s", (_label, err, kind) => {
		expect(translateProtonError(err).kind).toBe(kind);
	});

	it("tags human verification and quota with their own permanent codes", () => {
		expect(translateProtonError(sdk("APICodeError", { code: 9001 }))).toMatchObject({ permanentCode: "protondrive:human-verification" });
		expect(translateProtonError(sdk("APICodeError", { code: 200001 }))).toMatchObject({ permanentCode: "protondrive:quota" });
	});
});
