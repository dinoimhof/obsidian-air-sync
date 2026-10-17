import { describe, expect, it } from "vitest";
import type { CryptoApiInterface } from "@protontech/crypto";
import type { JsonValue } from "../../backend-api";
import { ProtonAccount } from "./account";
import type { KeyPassword } from "./session";
import type { ProtonTransport } from "./transport";

const EMAIL = "jane.doe@example.org";

function account(addresses: JsonValue): ProtonAccount {
	const transport = {
		json: (_method: string, path: string) =>
			Promise.resolve(path.startsWith("core/v4/addresses") ? { Code: 1000, Addresses: addresses } : { Code: 1000, User: { Keys: [] } }),
	} as unknown as ProtonTransport;
	const crypto = {
		importPrivateKey: () => Promise.reject(new Error(`Incorrect key passphrase for ${EMAIL}`)),
	} as unknown as CryptoApiInterface;
	return new ProtonAccount(transport, crypto, "kp" as KeyPassword);
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
	const err = await promise.then(() => null, (e: unknown) => e);
	expect(err).toBeInstanceOf(Error);
	return (err as Error).message;
}

describe("ProtonAccount error messages", () => {
	const addresses = [{ ID: "addr-1", Email: EMAIL, Keys: [{ ID: "key-1", PrivateKey: "armored" }] }];

	it("never name the requested address", async () => {
		const message = await messageOf(account(addresses).getOwnAddress("someone.else@example.org"));
		expect(message).not.toMatch(/@|someone/);
	});

	it("never name the address whose keys failed to decrypt", async () => {
		const message = await messageOf(account(addresses).getOwnPrimaryAddress());
		expect(message).not.toContain(EMAIL);
		expect(message).not.toContain("@");
	});
});
