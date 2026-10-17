import { afterEach, describe, expect, it, vi } from "vitest";
import { CryptoProxy } from "@protontech/crypto";
import type { BackendRuntimeContext } from "../../backend-api";
import type { ClientUid } from "./sdk-client";
import { openProtonDrive, releaseProtonDrive, telemetry } from "./sdk-client";
import { SESSION_SECRET_KEY } from "./session";

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

describe("Proton Drive connection lifetime", () => {
	function contextWithSession(): BackendRuntimeContext {
		const values = new Map<string, string>();
		const secrets = {
			get: (key: string) => Promise.resolve(values.get(key) ?? null),
			set: (key: string, value: string) => Promise.resolve(void values.set(key, value)),
			delete: (key: string) => Promise.resolve(void values.delete(key)),
		};
		values.set(SESSION_SECRET_KEY, JSON.stringify({ uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "KP" }));
		const quiet = () => undefined;
		return {
			http: { request: () => Promise.reject(new Error("no request expected")) },
			secrets,
			logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
			auth: { openExternal: () => Promise.resolve() },
		};
	}

	afterEach(async () => {
		await releaseProtonDrive();
		vi.restoreAllMocks();
	});

	it("opens one connection per runtime context, so keys are imported once per connection", async () => {
		const context = contextWithSession();
		const first = await openProtonDrive(context, "client" as ClientUid);
		expect(await openProtonDrive(context, "client" as ClientUid)).toBe(first);
		expect(await openProtonDrive(contextWithSession(), "client" as ClientUid)).not.toBe(first);
	});

	it("does not cache a failed open", async () => {
		const context = contextWithSession();
		await context.secrets.delete(SESSION_SECRET_KEY);
		await expect(openProtonDrive(context, "client" as ClientUid)).rejects.toMatchObject({ kind: "auth" });
		await context.secrets.set(SESSION_SECRET_KEY, JSON.stringify({ uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "KP" }));
		await expect(openProtonDrive(context, "client" as ClientUid)).resolves.toBeDefined();
	});

	it("releases the crypto endpoint (clearing its key store) and forgets every connection", async () => {
		const context = contextWithSession();
		const first = await openProtonDrive(context, "client" as ClientUid);
		const release = vi.spyOn(CryptoProxy, "releaseEndpoint");

		await releaseProtonDrive();

		expect(release).toHaveBeenCalledTimes(1);
		expect(await openProtonDrive(context, "client" as ClientUid)).not.toBe(first);
	});
});
