import { describe, expect, it } from "vitest";
import { translateProtonError } from "./errors";
import { ProtonApiError } from "./transport";

function sdkError(name: string, message: string, fields: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), { name }, fields);
}

describe("translateProtonError", () => {
	it("scrubs an SDK error message without changing its classification", () => {
		const leaky = "failed for jane.doe@example.org with Bearer s3cr3t at core/v4/keys/all?Email=jane";
		for (const [err, kind] of [
			[sdkError("APICodeError", leaky, { code: 200001 }), "permanent"],
			[sdkError("RateLimitedError", leaky), "rate_limit"],
			[sdkError("NotFoundAPIError", leaky), "not_found"],
			[sdkError("SomethingNew", leaky), "transient"],
		] as const) {
			const shape = translateProtonError(err);
			expect(shape.kind).toBe(kind);
			expect(shape.message).not.toMatch(/jane|s3cr3t|Email=/);
		}
		expect(translateProtonError(sdkError("APICodeError", leaky, { code: 200001 }))).toMatchObject({ permanentCode: "protondrive:quota" });
	});
});

describe("translateProtonError for provider-side change", () => {
	it("maps code 5003 (app update required) to a permanent, actionable error", () => {
		for (const err of [
			new ProtonApiError(400, 5003, "GET core/v4/users failed (400/5003)"),
			Object.assign(new Error("Upgrade required"), { name: "APICodeError", code: 5003 }),
		]) {
			expect(translateProtonError(err)).toMatchObject({
				kind: "permanent",
				permanentCode: "protondrive:app-update-required",
				message: expect.stringContaining("Update the plugin") as unknown,
			});
		}
	});
});
