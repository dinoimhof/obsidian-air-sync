import { describe, it, expect } from "vitest";
import { classifyProtonDriveError } from "./errors";
import { AuthError } from "../errors";

function sdkError(name: string, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(name), { name, ...extra });
}

describe("classifyProtonDriveError", () => {
	it("classifies an AuthError as auth regardless of shape", () => {
		expect(classifyProtonDriveError(new AuthError("expired", 401))).toEqual({ kind: "auth" });
	});

	it("classifies a RateLimitedError as rateLimit", () => {
		expect(classifyProtonDriveError(sdkError("RateLimitedError", { statusCode: 429, code: 1 }))).toEqual({ kind: "rateLimit" });
	});

	it.each([
		[401, "auth"],
		[403, "permission"],
		[404, "notFound"],
		[429, "rateLimit"],
		[500, "transient"],
	])("classifies a ServerError with statusCode %i as %s", (statusCode, kind) => {
		expect(classifyProtonDriveError(sdkError("ServerError", { statusCode }))).toEqual({ kind });
	});

	it("classifies a ServerError with no statusCode as transient", () => {
		expect(classifyProtonDriveError(sdkError("ServerError"))).toEqual({ kind: "transient" });
	});

	it("classifies a ConnectionError as transient", () => {
		expect(classifyProtonDriveError(sdkError("ConnectionError"))).toEqual({ kind: "transient" });
	});

	it("falls back to the neutral HTTP classification for a transport-level error", () => {
		expect(classifyProtonDriveError(Object.assign(new Error("boom"), { status: 404 }))).toEqual({ kind: "notFound" });
	});

	it("falls back to the neutral HTTP classification for a non-object throw", () => {
		expect(classifyProtonDriveError("boom")).toEqual({ kind: "transient" });
	});
});
