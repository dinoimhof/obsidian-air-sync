import { describe, expect, it } from "vitest";
import { translateProtonError } from "./errors";

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
