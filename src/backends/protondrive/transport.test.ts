import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendHttpClient, BackendHttpRequest, JsonValue } from "../../backend-api";
import { ProtonApiError, ProtonTransport } from "./transport";

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
