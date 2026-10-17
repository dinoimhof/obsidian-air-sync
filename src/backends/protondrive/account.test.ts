import { describe, expect, it } from "vitest";
import type { CryptoApiInterface } from "@protontech/crypto";
import type { JsonValue } from "../../backend-api";
import { ProtonAccount } from "./account";
import type { KeyPassword } from "./session";
import type { ProtonTransport } from "./transport";

const EMAIL = "jane.doe@example.org";

function account(addresses: JsonValue, userKeys: JsonValue = [], crypto?: Partial<CryptoApiInterface>): ProtonAccount {
	const transport = {
		json: (_method: string, path: string) =>
			Promise.resolve(path.startsWith("core/v4/addresses") ? { Code: 1000, Addresses: addresses } : { Code: 1000, User: { Keys: userKeys } }),
	} as unknown as ProtonTransport;
	const failing = {
		importPrivateKey: () => Promise.reject(new Error(`Incorrect key passphrase for ${EMAIL}`)),
	};
	return new ProtonAccount(transport, { ...failing, ...crypto } as unknown as CryptoApiInterface, () => Promise.resolve("kp" as KeyPassword));
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

describe("ProtonAccount when reconnecting cannot help", () => {
	const opensUserKeys: Partial<CryptoApiInterface> = {
		importPrivateKey: ((options: { armoredKey: string }) =>
			options.armoredKey === "armored-user-key" || options.armoredKey === "good"
				? Promise.resolve({ id: options.armoredKey })
				: Promise.reject(new Error("Incorrect key passphrase"))) as unknown as CryptoApiInterface["importPrivateKey"],
		exportPublicKey: () => Promise.resolve(new Uint8Array()),
		importPublicKey: (() => Promise.resolve({})) as unknown as CryptoApiInterface["importPublicKey"],
		decryptMessage: () => Promise.resolve({ data: "", verificationStatus: 0 }),
	};

	it("reports a permanent error, not auth, for an address with no key", async () => {
		await expect(account([{ ID: "a", Email: EMAIL, Keys: [] }]).getOwnPrimaryAddress()).rejects.toMatchObject({ kind: "permanent" });
	});

	it("reports a permanent error, not auth, when the user keys open but a token signature is invalid", async () => {
		const tokenKeys = [{ ID: "a", Email: EMAIL, Keys: [{ ID: "k", PrivateKey: "armored", Token: "t", Signature: "s" }] }];
		await expect(account(tokenKeys, [{ PrivateKey: "armored-user-key" }], opensUserKeys).getOwnPrimaryAddress())
			.rejects.toMatchObject({ kind: "permanent" });
	});

	it("skips a secondary address whose keys cannot be opened instead of failing the account", async () => {
		const addresses = [
			{ ID: "a1", Email: EMAIL, Keys: [{ ID: "k1", PrivateKey: "good" }] },
			{ ID: "a2", Email: "second@example.org", Keys: [] },
		];
		const own = await account(addresses, [], opensUserKeys).getOwnAddresses();
		expect(own.map((address) => address.addressId)).toEqual(["a1"]);
	});
});

describe("ProtonAccount primary address, primary key and pagination", () => {
	const opens = {
		importPrivateKey: (() => Promise.resolve({})) as unknown as CryptoApiInterface["importPrivateKey"],
	};
	const address = (id: string, priority: number | undefined, keys: JsonValue = [{ ID: `${id}-k`, PrivateKey: "armored" }]) =>
		({ ID: id, Email: `${id}@example.org`, Keys: keys, ...(priority === undefined ? {} : { Priority: priority }) });

	it("takes the primary address by Priority, falling back to the API's order", async () => {
		expect((await account([address("b", 2), address("a", 1)], [], opens).getOwnPrimaryAddress()).addressId).toBe("a");
		expect((await account([address("b", undefined), address("a", undefined)], [], opens).getOwnPrimaryAddress()).addressId).toBe("b");
	});

	it("takes the primary key by its Primary flag", async () => {
		const keys = [{ ID: "k1", PrivateKey: "armored", Primary: 0 }, { ID: "k2", PrivateKey: "armored", Primary: 1 }];
		const own = await account([address("a", 1, keys)], [], opens).getOwnPrimaryAddress();
		expect(own.keys[own.primaryKeyIndex]?.id).toBe("k2");
	});

	it("reads every page of addresses (pagination)", async () => {
		const pages = [Array.from({ length: 50 }, (_, i) => address(`p0-${i}`, i + 1)), [address("p1-0", 51), address("p1-1", 52)]];
		const requested: string[] = [];
		const transport = {
			json: (_method: string, path: string) => {
				requested.push(path);
				const page = Number(/Page=(\d+)/.exec(path)?.[1] ?? 0);
				return Promise.resolve({ Code: 1000, Addresses: pages[page] ?? [] });
			},
		} as unknown as ProtonTransport;
		const own = await new ProtonAccount(transport, opens as unknown as CryptoApiInterface, () => Promise.resolve("kp" as KeyPassword)).getOwnAddresses();
		expect(own).toHaveLength(52);
		expect(requested).toEqual(["core/v4/addresses?Page=0&PageSize=50", "core/v4/addresses?Page=1&PageSize=50"]);
	});
});
