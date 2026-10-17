import { describe, expect, it } from "vitest";
import { telemetry } from "./sdk-client";

describe("SDK telemetry bridge", () => {
	it("scrubs emails and tokens from SDK log messages and errors", () => {
		const lines: string[] = [];
		const record = (message: string, context?: Record<string, unknown>) => void lines.push(JSON.stringify([message, context]));
		const sdk = telemetry({ debug: record, info: record, warn: record, error: record }).getLogger("nodes");

		sdk.warn("Could not find signing key for jane.doe@example.org");
		sdk.error("Request failed", new Error("401 with Bearer s3cr3t-token at /auth/v4/sessions/forks/SEL"));

		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toMatch(/jane\.doe@example\.org|s3cr3t-token|forks\/SEL/);
	});
});
