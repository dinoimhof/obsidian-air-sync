import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeAuthedAuth() {
	const { ProtonDriveAuthProvider } = await import("./auth");
	const store = createMockSecretStore({
		"air-sync-protondrive-refresh-token": "RT",
		"air-sync-protondrive-access-token": "AT",
		"air-sync-protondrive-uid-token": "UID",
		"air-sync-protondrive-keyPassword-token": "KP",
	});
	const provider = new ProtonDriveAuthProvider(store, undefined, () => Promise.resolve());
	return provider.getOrCreateAuth();
}

describe("ProtonApiClient.unauthenticatedRequest", () => {
	it("sends only the x-pm-appversion header, no uid/bearer", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ ok: true }));
		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		await client.unauthenticatedRequest("https://drive-api.proton.me/auth/v4/sessions/forks");

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.headers?.["x-pm-appversion"]).toBeTruthy();
		expect(opts.headers?.["x-pm-uid"]).toBeUndefined();
		expect(opts.headers?.Authorization).toBeUndefined();
	});
});

describe("ProtonApiClient.authenticatedRequest", () => {
	it("adds x-pm-uid and a Bearer token from the shared auth", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ ok: true }));
		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		await client.authenticatedRequest("https://drive-api.proton.me/core/v4/users");

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.headers?.["x-pm-uid"]).toBe("UID");
		expect(opts.headers?.Authorization).toBe("Bearer AT");
	});

	it("forces exactly one refresh-and-retry on a 401, then returns the retried response", async () => {
		const spy = await spyRequestUrl();
		spy.mockResolvedValueOnce(mockRes({ error: "expired" }, { status: 401 }));
		spy.mockResolvedValueOnce(mockRes({ UID: "UID", AccessToken: "AT2", RefreshToken: "RT2" })); // performRefresh
		spy.mockResolvedValueOnce(mockRes({ ok: true })); // retried call

		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		const res = await client.authenticatedRequest("https://drive-api.proton.me/core/v4/users");

		expect(res.status).toBe(200);
		expect(spy).toHaveBeenCalledTimes(3);
		const retriedOpts = spy.mock.calls[2]![0] as RequestUrlParam;
		expect(retriedOpts.headers?.Authorization).toBe("Bearer AT2");
	});

	it("does not retry a second time if the retried call is also a 401", async () => {
		const spy = await spyRequestUrl();
		spy.mockResolvedValueOnce(mockRes({}, { status: 401 }));
		spy.mockResolvedValueOnce(mockRes({ UID: "UID", AccessToken: "AT2", RefreshToken: "RT2" }));
		spy.mockResolvedValueOnce(mockRes({}, { status: 401 }));

		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		const res = await client.authenticatedRequest("https://drive-api.proton.me/core/v4/users");
		expect(res.status).toBe(401);
		expect(spy).toHaveBeenCalledTimes(3);
	});

	it("preserves an absolute URL to a different host verbatim (regional storage)", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ ok: true }));
		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		await client.authenticatedRequest("https://zrh-storage.proton.me/storage/blocks");

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toBe("https://zrh-storage.proton.me/storage/blocks");
	});

	it("serializes a json body and sets Content-Type", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ ok: true }));
		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		await client.authenticatedRequest("https://drive-api.proton.me/auth/v4/refresh", {
			method: "POST",
			json: { GrantType: "refresh_token" },
		});

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.headers?.["Content-Type"]).toBe("application/json");
		expect(JSON.parse(opts.body as string)).toEqual({ GrantType: "refresh_token" });
	});

	it("applies searchParams onto the URL", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ ok: true }));
		const { ProtonApiClient } = await import("./api-client");
		const auth = await makeAuthedAuth();
		const client = new ProtonApiClient(auth);

		await client.authenticatedRequest("https://drive-api.proton.me/core/v4/addresses", {
			searchParams: { Page: 0, PageSize: 50 },
		});

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		const url = new URL(opts.url);
		expect(url.searchParams.get("Page")).toBe("0");
		expect(url.searchParams.get("PageSize")).toBe("50");
	});
});
