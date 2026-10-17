import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendHttpClient, BackendHttpRequest, JsonValue } from "../../backend-api";
import { ProtonApiError, ProtonTransport, retryAfterMsFrom } from "./transport";
import type { StoredSession } from "./session";
import { SessionHandle, saveSession } from "./session";

beforeAll(() => {
	vi.stubGlobal("window", { setTimeout, clearTimeout });
});

function reply(status: number, body: JsonValue) {
	const text = JSON.stringify(body);
	return {
		status,
		headers: { "content-type": "application/json" },
		text: () => Promise.resolve(text),
		arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
		json: () => Promise.resolve(body),
	};
}

function failingTransport(status: number, body: JsonValue): { transport: ProtonTransport; requests: BackendHttpRequest[] } {
	const requests: BackendHttpRequest[] = [];
	const http: BackendHttpClient = {
		request: (request) => {
			requests.push(request);
			return Promise.resolve(reply(status, body));
		},
	};
	return { transport: new ProtonTransport(http, null), requests };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
	const err = await promise.then(() => null, (e: unknown) => e);
	expect(err).toBeInstanceOf(ProtonApiError);
	return (err as ProtonApiError).message;
}

describe("ProtonTransport error messages", () => {
	it("never carry the query (an email) or Proton's free-text detail", async () => {
		const { transport, requests } = failingTransport(422, { Code: 33102, Error: "jane.doe@example.org has no keys" });

		const message = await messageOf(transport.json("GET", "core/v4/keys/all?Email=jane.doe%40example.org&InternalOnly=1"));

		expect(requests[0]?.url).toContain("Email=");
		expect(message).toBe("GET core/v4/keys/all failed (422/33102)");
		expect(message).not.toMatch(/jane|Email|has no keys/);
	});

	it("never carry the fork selector", async () => {
		const { transport } = failingTransport(500, { Code: 2000 });

		const message = await messageOf(transport.json("GET", "auth/v4/sessions/forks/S3cretSelector"));

		expect(message).not.toContain("S3cretSelector");
		expect(message).toContain("auth/v4/sessions/forks/{id}");
	});

	it("keep the status and code a caller classifies on", async () => {
		const { transport } = failingTransport(429, { Code: 2028 });
		const err = await transport.json("GET", "core/v4/users").catch((e: unknown) => e);
		expect(err).toMatchObject({ status: 429, code: 2028 });
	});
});

describe("ProtonTransport host allowlist", () => {
	async function sessionTransport(statusFor: (url: string) => number) {
		const values = new Map<string, string>();
		const secrets = {
			get: (key: string) => Promise.resolve(values.get(key) ?? null),
			set: (key: string, value: string) => Promise.resolve(void values.set(key, value)),
			delete: (key: string) => Promise.resolve(void values.delete(key)),
		};
		await saveSession(secrets, { uid: "UID", accessToken: "AT", refreshToken: "RT", sealedKeyPassword: "sealed" } as StoredSession);
		const requests: BackendHttpRequest[] = [];
		const http: BackendHttpClient = {
			request: (request) => {
				requests.push(request);
				return Promise.resolve(reply(statusFor(request.url), { Code: 1000 }));
			},
		};
		return { transport: new ProtonTransport(http, await SessionHandle.open(secrets)), requests };
	}

	const sdkRequest = (url: string) => ({ url, method: "GET", headers: new Headers(), timeoutMs: 1000 });

	it("refuses http and non-Proton hosts before sending anything", async () => {
		const { transport, requests } = await sessionTransport(() => 200);
		for (const url of [
			"http://drive-api.proton.me/core/v4/users",
			"https://evil.example/block",
			"https://proton.me.evil.example/block",
			"https://notproton.me/block",
		]) {
			await expect(transport.fetch(sdkRequest(url))).rejects.toMatchObject({ kind: "permanent" });
		}
		expect(requests).toHaveLength(0);
	});

	it("refuses URLs that other parsers could read as a different host", async () => {
		const { transport, requests } = await sessionTransport(() => 200);
		for (const url of [
			"https://drive-api.proton.me\\@evil.example/x",
			"https://proton.me@evil.example/x",
			"https://user:pw@drive-api.proton.me/x",
			"https://drive-api.proton.me/a b",
			"https://drive-api.proton.me/a\tb",
		]) {
			await expect(transport.fetch(sdkRequest(url))).rejects.toMatchObject({ kind: "permanent" });
		}
		expect(requests).toHaveLength(0);
	});

	it("sends the normalized URL it validated", async () => {
		const { transport, requests } = await sessionTransport(() => 200);
		await transport.fetch(sdkRequest("https://DRIVE-API.proton.me/core/v4/users"));
		expect(requests[0]?.url).toBe("https://drive-api.proton.me/core/v4/users");
	});

	it("refreshes on a 401 from the API host and replays with the new token", async () => {
		const values = new Map<string, string>();
		const secrets = {
			get: (key: string) => Promise.resolve(values.get(key) ?? null),
			set: (key: string, value: string) => Promise.resolve(void values.set(key, value)),
			delete: (key: string) => Promise.resolve(void values.delete(key)),
		};
		await saveSession(secrets, { uid: "UID", accessToken: "AT", refreshToken: "RT", sealedKeyPassword: "sealed" } as StoredSession);
		const requests: BackendHttpRequest[] = [];
		const http: BackendHttpClient = {
			request: (request) => {
				requests.push(request);
				if (request.url.endsWith("/auth/v4/refresh")) {
					return Promise.resolve(reply(200, { Code: 1000, UID: "UID", AccessToken: "AT2", RefreshToken: "RT2" }));
				}
				return Promise.resolve(reply(request.headers?.authorization === "Bearer AT2" ? 200 : 401, { Code: 1000 }));
			},
		};
		const transport = new ProtonTransport(http, await SessionHandle.open(secrets));

		await expect(transport.json("GET", "core/v4/users")).resolves.toMatchObject({ Code: 1000 });

		expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/core/v4/users", "/auth/v4/refresh", "/core/v4/users"]);
		expect(requests[2]?.headers?.authorization).toBe("Bearer AT2");
	});

	it("allows Proton storage hosts", async () => {
		const { transport, requests } = await sessionTransport(() => 200);
		await transport.fetch(sdkRequest("https://fra-storage.proton.me/storage/blocks/abc"));
		expect(requests.map((r) => new URL(r.url).hostname)).toEqual(["fra-storage.proton.me"]);
	});

	it("refreshes the session only for a 401 from the API host, never from storage", async () => {
		const { transport, requests } = await sessionTransport((url) => (url.includes("storage") ? 401 : 200));
		const response = await transport.fetch(sdkRequest("https://fra-storage.proton.me/storage/blocks/abc"));
		expect(response.status).toBe(401);
		expect(requests.some((r) => r.url.endsWith("/auth/v4/refresh"))).toBe(false);
	});
});

describe("Retry-After", () => {
	it("is read as seconds or an HTTP date and clamped to 15 minutes", () => {
		expect(retryAfterMsFrom({ "Retry-After": "7" })).toBe(7000);
		expect(retryAfterMsFrom({ "retry-after": "999999" })).toBe(15 * 60 * 1000);
		expect(retryAfterMsFrom({ "retry-after": new Date(10_000).toUTCString() }, 4_000)).toBe(6000);
		expect(retryAfterMsFrom({ "retry-after": "soon" })).toBeUndefined();
		expect(retryAfterMsFrom({})).toBeUndefined();
	});

	it("reaches the error of a rate-limited API call", async () => {
		const http: BackendHttpClient = {
			request: () => Promise.resolve({ ...reply(429, { Code: 2028 }), headers: { "content-type": "application/json", "retry-after": "3" } }),
		};
		const err = await new ProtonTransport(http, null).json("GET", "core/v4/users").catch((e: unknown) => e);
		expect(err).toMatchObject({ status: 429, retryAfterMs: 3000 });
	});
});

describe("Retry-After on the session refresh", () => {
	async function refreshAnswering(status: number) {
		const values = new Map<string, string>();
		const secrets = {
			get: (key: string) => Promise.resolve(values.get(key) ?? null),
			set: (key: string, value: string) => Promise.resolve(void values.set(key, value)),
			delete: (key: string) => Promise.resolve(void values.delete(key)),
		};
		await saveSession(secrets, { uid: "UID", accessToken: "AT", refreshToken: "RT", sealedKeyPassword: "sealed" } as StoredSession);
		const http: BackendHttpClient = {
			request: (request) =>
				Promise.resolve(
					request.url.endsWith("/auth/v4/refresh")
						? { ...reply(status, { Code: 2028 }), headers: { "retry-after": "4" } }
						: reply(401, { Code: 401 }),
				),
		};
		return new ProtonTransport(http, await SessionHandle.open(secrets)).json("GET", "core/v4/users").catch((e: unknown) => e);
	}

	it("carries the hint on a rate-limited refresh", async () => {
		expect(await refreshAnswering(429)).toMatchObject({ kind: "rate_limit", retryAfterMs: 4000 });
	});

	it("carries the hint on a refresh that fails with 503", async () => {
		expect(await refreshAnswering(503)).toMatchObject({ kind: "transient", retryAfterMs: 4000 });
	});
});

describe("session routes and refresh", () => {
	it("refreshes on a 401 from an authenticated session route such as the local key", async () => {
		const values = new Map<string, string>();
		const secrets = {
			get: (key: string) => Promise.resolve(values.get(key) ?? null),
			set: (key: string, value: string) => Promise.resolve(void values.set(key, value)),
			delete: (key: string) => Promise.resolve(void values.delete(key)),
		};
		await saveSession(secrets, { uid: "UID", accessToken: "AT", refreshToken: "RT", sealedKeyPassword: "sealed" } as StoredSession);
		const paths: string[] = [];
		const http: BackendHttpClient = {
			request: (request) => {
				paths.push(new URL(request.url).pathname);
				if (request.url.endsWith("/auth/v4/refresh")) return Promise.resolve(reply(200, { Code: 1000, UID: "UID", AccessToken: "AT2", RefreshToken: "RT2" }));
				return Promise.resolve(reply(request.headers?.authorization === "Bearer AT2" ? 200 : 401, { Code: 1000, ClientKey: "k" }));
			},
		};
		await new ProtonTransport(http, await SessionHandle.open(secrets)).json("GET", "auth/v4/sessions/local/key");
		expect(paths).toEqual(["/auth/v4/sessions/local/key", "/auth/v4/refresh", "/auth/v4/sessions/local/key"]);
	});
});
