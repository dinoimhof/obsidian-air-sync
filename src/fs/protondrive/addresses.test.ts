import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const cryptoImportPrivateKey = vi.fn();
const cryptoImportPublicKeyArmored = vi.fn();
const cryptoImportPublicKeyBinary = vi.fn();
const cryptoExportPublicKeyBinary = vi.fn();
const cryptoDecryptAndVerify = vi.fn();

vi.mock("../../platform/protondrive-crypto", () => ({
	cryptoImportPrivateKey,
	cryptoImportPublicKeyArmored,
	cryptoImportPublicKeyBinary,
	cryptoExportPublicKeyBinary,
	cryptoDecryptAndVerify,
}));

afterEach(() => {
	vi.clearAllMocks();
});

function fakeAuth(keyPassword = "the-key-password") {
	return { getKeyPassword: () => keyPassword } as unknown as import("./auth").ProtonDriveAuth;
}

function fakeAccountApi(overrides: Partial<{
	users: () => Promise<unknown>;
	addresses: () => Promise<unknown>;
	keys: (email: string) => Promise<unknown>;
}> = {}) {
	return {
		users: overrides.users ?? (() => Promise.resolve({ User: { Keys: [{ PrivateKey: "user-armored" }] } })),
		addresses: overrides.addresses
			?? (() => Promise.resolve({
				Addresses: [{ ID: "addr1", Email: "me@example.com", Keys: [{ ID: "k1", PrivateKey: "addr-armored" }] }],
			})),
		keys: overrides.keys ?? (() => Promise.resolve({ Address: { Keys: [] } })),
	} as unknown as import("./account-api").ProtonAccountApi;
}

beforeEach(() => {
	cryptoImportPrivateKey.mockImplementation((armoredKey: string) => Promise.resolve(`priv:${armoredKey}`));
	cryptoImportPublicKeyArmored.mockImplementation((armoredKey: string) => Promise.resolve(`pub:${armoredKey}`));
	cryptoImportPublicKeyBinary.mockResolvedValue("pub:binary");
	cryptoExportPublicKeyBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("ProtonDriveAddresses.getOwnAddress — legacy (no Token) key shape", () => {
	it("decrypts the address key directly with the account keyPassword", async () => {
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(fakeAccountApi(), fakeAuth("kp"));

		const address = await addresses.getOwnAddress("addr1");

		expect(address.email).toBe("me@example.com");
		expect(address.addressId).toBe("addr1");
		expect(address.keys).toHaveLength(1);
		expect(cryptoImportPrivateKey).toHaveBeenCalledWith("addr-armored", "kp");
	});

	it("caches the decrypted key across repeated calls for the same key ID", async () => {
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(fakeAccountApi(), fakeAuth());

		await addresses.getOwnAddress("addr1");
		await addresses.getOwnAddress("addr1");

		expect(cryptoImportPrivateKey).toHaveBeenCalledTimes(2); // 1 user key + 1 address key, not doubled
	});
});

describe("ProtonDriveAddresses.getOwnAddress — modern (Token+Signature) key shape", () => {
	it("verifies the token signature, then uses the decrypted token as the key passphrase", async () => {
		cryptoDecryptAndVerify.mockResolvedValue({ data: "decrypted-token", verified: true });
		const accountApi = fakeAccountApi({
			addresses: () => Promise.resolve({
				Addresses: [{
					ID: "addr1",
					Email: "me@example.com",
					Keys: [{ ID: "k1", PrivateKey: "addr-armored", Token: "tok", Signature: "sig" }],
				}],
			}),
		});
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(accountApi, fakeAuth());

		await addresses.getOwnAddress("addr1");

		expect(cryptoDecryptAndVerify).toHaveBeenCalledWith("tok", "sig", expect.any(Array), expect.any(Array));
		expect(cryptoImportPrivateKey).toHaveBeenCalledWith("addr-armored", "decrypted-token");
	});

	it("throws when the token's signature does not verify", async () => {
		cryptoDecryptAndVerify.mockResolvedValue({ data: "x", verified: false });
		const accountApi = fakeAccountApi({
			addresses: () => Promise.resolve({
				Addresses: [{ ID: "addr1", Email: "me@example.com", Keys: [{ ID: "k1", PrivateKey: "a", Token: "t", Signature: "s" }] }],
			}),
		});
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(accountApi, fakeAuth());

		await expect(addresses.getOwnAddress("addr1")).rejects.toThrow("signature verification failed");
	});
});

describe("ProtonDriveAddresses error handling", () => {
	it("throws immediately when there is no key password (not logged in)", async () => {
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(fakeAccountApi(), fakeAuth(""));

		await expect(addresses.getOwnAddress("addr1")).rejects.toThrow("no key password");
	});

	it("throws for an unknown address id/email", async () => {
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(fakeAccountApi(), fakeAuth());

		await expect(addresses.getOwnAddress("nope")).rejects.toThrow("not found");
	});

	it("re-fetches user data after a failure instead of caching the rejection", async () => {
		let calls = 0;
		const accountApi = fakeAccountApi({
			users: () => {
				calls++;
				return calls === 1 ? Promise.reject(new Error("network blip")) : Promise.resolve({ User: { Keys: [{ PrivateKey: "u" }] } });
			},
		});
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(accountApi, fakeAuth());

		await expect(addresses.getOwnAddress("addr1")).rejects.toThrow("network blip");
		await expect(addresses.getOwnAddress("addr1")).resolves.toBeTruthy();
		expect(calls).toBe(2);
	});
});

describe("ProtonDriveAddresses.getPublicKeys", () => {
	it("returns the caller's own address public keys without a network round trip to /keys/all", async () => {
		const keysSpy = vi.fn(() => Promise.resolve({ Address: { Keys: [] } }));
		const accountApi = fakeAccountApi({ keys: keysSpy });
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(accountApi, fakeAuth());

		const keys = await addresses.getPublicKeys("me@example.com");

		expect(keys).toHaveLength(1);
		expect(keysSpy).not.toHaveBeenCalled();
	});

	it("falls back to /keys/all for a different user's email", async () => {
		const accountApi = fakeAccountApi({
			keys: () => Promise.resolve({ Address: { Keys: [{ PublicKey: "other-pub" }] } }),
		});
		const { ProtonDriveAddresses } = await import("./addresses");
		const addresses = new ProtonDriveAddresses(accountApi, fakeAuth());

		const keys = await addresses.getPublicKeys("other@example.com");

		expect(keys).toEqual(["pub:other-pub"]);
	});
});
