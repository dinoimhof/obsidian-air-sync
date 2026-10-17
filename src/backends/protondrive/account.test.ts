import { describe, expect, it } from "vitest";
import type { CryptoApiInterface } from "@protontech/crypto";
import type { JsonValue } from "../../backend-api";
import { ProtonAccount } from "./account";
import type { KeyPassword } from "./session";
import type { ProtonTransport } from "./transport";

const EMAIL = "jane.doe@example.org";

function account(addresses: JsonValue, userKeys: JsonValue = []): ProtonAccount {
	const transport = {
		json: (_method: string, path: string) =>
			Promise.resolve(path.startsWith("core/v4/addresses") ? { Code: 1000, Addresses: addresses } : { Code: 1000, User: { Keys: userKeys } }),
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

describe("ProtonAccount after a Proton password change", () => {
	it("reports auth (reconnect) when no user key opens with the stored key password", async () => {
		const tokenKeys = [{ ID: "addr-1", Email: EMAIL, Keys: [{ ID: "key-1", PrivateKey: "armored", Token: "t", Signature: "s" }] }];
		const err = await account(tokenKeys, [{ PrivateKey: "armored-user-key" }]).getOwnPrimaryAddress().catch((e: unknown) => e);
		expect(err).toMatchObject({ kind: "auth", message: expect.stringContaining("Reconnect") as unknown });
	});

	it("reports auth when no legacy address key opens with the stored key password", async () => {
		const legacy = [{ ID: "addr-1", Email: EMAIL, Keys: [{ ID: "key-1", PrivateKey: "armored" }] }];
		await expect(account(legacy).getOwnPrimaryAddress()).rejects.toMatchObject({ kind: "auth" });
	});

	it("reports a permanent error for an account with no user key at all", async () => {
		const tokenKeys = [{ ID: "addr-1", Email: EMAIL, Keys: [{ ID: "key-1", PrivateKey: "armored", Token: "t" }] }];
		await expect(account(tokenKeys, []).getOwnPrimaryAddress()).rejects.toMatchObject({ kind: "permanent" });
	});
});
