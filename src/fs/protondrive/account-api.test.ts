import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeAccountApi() {
	const { ProtonDriveAuthProvider } = await import("./auth");
	const { ProtonApiClient } = await import("./api-client");
	const { ProtonAccountApi } = await import("./account-api");
	const store = createMockSecretStore({
		"air-sync-protondrive-refresh-token": "RT",
		"air-sync-protondrive-access-token": "AT",
		"air-sync-protondrive-uid-token": "UID",
		"air-sync-protondrive-key-password-token": "KP",
	});
	const provider = new ProtonDriveAuthProvider(store, undefined, () => Promise.resolve());
	const auth = provider.getOrCreateAuth();
	return new ProtonAccountApi(new ProtonApiClient(auth));
}

describe("ProtonAccountApi", () => {
	it("users() hits /core/v4/users and returns the parsed body", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ User: { Keys: [{ PrivateKey: "armored" }] } }));
		const api = await makeAccountApi();

		const result = await api.users();

		expect((spy.mock.calls[0]![0] as RequestUrlParam).url).toBe("https://drive-api.proton.me/core/v4/users");
		expect(result.User?.Keys?.[0]?.PrivateKey).toBe("armored");
	});

	it("addresses() pages with Page=0 and a PageSize", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ Addresses: [{ ID: "a1", Email: "x@example.com" }] }));
		const api = await makeAccountApi();

		const result = await api.addresses();

		const url = new URL((spy.mock.calls[0]![0] as RequestUrlParam).url);
		expect(url.pathname).toBe("/core/v4/addresses");
		expect(url.searchParams.get("Page")).toBe("0");
		expect(result.Addresses?.[0]?.Email).toBe("x@example.com");
	});

	it("keys(email) queries by Email and InternalOnly", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ Address: { Keys: [{ PublicKey: "pub" }] } }));
		const api = await makeAccountApi();

		await api.keys("someone@example.com");

		const url = new URL((spy.mock.calls[0]![0] as RequestUrlParam).url);
		expect(url.searchParams.get("Email")).toBe("someone@example.com");
		expect(url.searchParams.get("InternalOnly")).toBe("1");
	});

	it("modulus() throws with the status on a non-200 response", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({}, { status: 500 }));
		const api = await makeAccountApi();

		await expect(api.modulus()).rejects.toThrow("500");
	});

	it("throws when a 200 response body is not a JSON object", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(null));
		const api = await makeAccountApi();

		await expect(api.users()).rejects.toThrow("invalid users response");
	});
});
