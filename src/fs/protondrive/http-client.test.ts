import { describe, it, expect, vi } from "vitest";
import { ProtonDriveHttpClient } from "./http-client";
import type { ProtonApiClient } from "./api-client";

function fakeApiClient(status = 200, arrayBuffer: ArrayBuffer = new ArrayBuffer(0)) {
	const authenticatedRequest = vi.fn().mockResolvedValue({
		status,
		headers: { "content-type": "application/octet-stream" },
		arrayBuffer,
		json: undefined,
		text: "",
	});
	// Kept as a separate local binding (never accessed as `client.authenticatedRequest`
	// at the assertion site) so it reads as a plain mock function, not a class method
	// reference losing its `this` binding (@typescript-eslint/unbound-method).
	const client = { authenticatedRequest } as unknown as ProtonApiClient;
	return { client, authenticatedRequest };
}

function fakeHeaders(entries: Record<string, string>): Headers {
	const headers = new Headers();
	for (const [k, v] of Object.entries(entries)) headers.set(k, v);
	return headers;
}

describe("ProtonDriveHttpClient.fetchJson", () => {
	it("passes the SDK's URL through verbatim and forwards a json body", async () => {
		const { client, authenticatedRequest } = fakeApiClient();
		const httpClient = new ProtonDriveHttpClient(client);

		await httpClient.fetchJson({
			url: "https://drive-api.proton.me/drive/v2/files",
			method: "POST",
			headers: fakeHeaders({ "x-custom": "1" }),
			timeoutMs: 30000,
			json: { Name: "test" },
		});

		expect(authenticatedRequest).toHaveBeenCalledWith(
			"https://drive-api.proton.me/drive/v2/files",
			expect.objectContaining({ method: "POST", json: { Name: "test" }, headers: { "x-custom": "1" } }),
		);
	});

	it("returns a real Response reflecting the underlying status", async () => {
		const { client } = fakeApiClient(404);
		const httpClient = new ProtonDriveHttpClient(client);

		const res = await httpClient.fetchJson({
			url: "https://drive-api.proton.me/x",
			method: "GET",
			headers: fakeHeaders({}),
			timeoutMs: 30000,
		});

		expect(res.status).toBe(404);
	});

	it("converts a string body when no json is given", async () => {
		const { client, authenticatedRequest } = fakeApiClient();
		const httpClient = new ProtonDriveHttpClient(client);

		await httpClient.fetchJson({
			url: "https://drive-api.proton.me/x",
			method: "PUT",
			headers: fakeHeaders({}),
			timeoutMs: 30000,
			body: "raw-text-body",
		});

		expect(authenticatedRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ body: "raw-text-body" }),
		);
	});
});

describe("ProtonDriveHttpClient.fetchBlob", () => {
	it("converts a Uint8Array body to an ArrayBuffer slice", async () => {
		const { client, authenticatedRequest } = fakeApiClient();
		const httpClient = new ProtonDriveHttpClient(client);
		const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3); // a view with a byteOffset

		await httpClient.fetchBlob({
			url: "https://zrh-storage.proton.me/storage/blocks",
			method: "POST",
			headers: fakeHeaders({}),
			timeoutMs: 30000,
			body: bytes,
		});

		const call = authenticatedRequest.mock.calls[0]![1] as { body: ArrayBuffer };
		expect(new Uint8Array(call.body)).toEqual(new Uint8Array([2, 3]));
	});

	it("rejects an unsupported body type instead of silently mishandling it", async () => {
		const { client } = fakeApiClient();
		const httpClient = new ProtonDriveHttpClient(client);

		await expect(
			httpClient.fetchBlob({
				url: "https://zrh-storage.proton.me/storage/blocks",
				method: "POST",
				headers: fakeHeaders({}),
				timeoutMs: 30000,
				body: new URLSearchParams({ a: "1" }),
			}),
		).rejects.toThrow("unsupported request body type");
	});

	it("encodes a FormData body as multipart/form-data with a matching boundary header, instead of throwing", async () => {
		const { client, authenticatedRequest } = fakeApiClient();
		const httpClient = new ProtonDriveHttpClient(client);
		const formData = new FormData();
		formData.set("Metadata", new Blob([JSON.stringify({ Name: "x" })], { type: "application/json" }), "Metadata");
		formData.set("ContentBlock", new Blob([new Uint8Array([1, 2, 3])]), "ContentBlock");

		await httpClient.fetchBlob({
			url: "https://drive-api.proton.me/drive/v2/volumes/v/files/small",
			method: "POST",
			headers: fakeHeaders({}),
			timeoutMs: 30000,
			body: formData,
		});

		const call = authenticatedRequest.mock.calls[0]![1] as { body: ArrayBuffer; headers: Record<string, string> };
		const boundaryMatch = /^multipart\/form-data; boundary=(\S+)$/.exec(call.headers["Content-Type"] ?? "");
		expect(boundaryMatch).not.toBeNull();
		const boundary = boundaryMatch![1];
		const text = new TextDecoder().decode(call.body);
		expect(text).toContain(`--${boundary}\r\n`);
		expect(text).toContain('Content-Disposition: form-data; name="Metadata"; filename="Metadata"');
		expect(text).toContain("Content-Type: application/json");
		expect(text).toContain('Content-Disposition: form-data; name="ContentBlock"; filename="ContentBlock"');
		expect(text).toContain(`--${boundary}--\r\n`);
	});
});
