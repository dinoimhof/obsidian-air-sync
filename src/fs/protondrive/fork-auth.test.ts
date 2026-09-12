import { describe, it, expect, vi, afterEach } from "vitest";
import { spyRequestUrl, mockRes } from "./test-helpers";
import {
	decryptForkKeyPassword,
	generateForkSignInUrl,
	sessionForksInit,
	sessionForksStatus,
} from "./fork-auth";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

/** Encrypt a fork payload the same way Proton's login page would, for test fixtures. */
async function encryptForkPayload(encryptionKey: Uint8Array, keyPassword: string): Promise<string> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey("raw", Uint8Array.from(encryptionKey), { name: "AES-GCM" }, false, [
		"encrypt",
	]);
	const plaintext = new TextEncoder().encode(JSON.stringify({ type: "default", keyPassword }));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode("fork"), tagLength: 128 },
		cryptoKey,
		plaintext,
	);
	const blob = new Uint8Array(nonce.length + ciphertext.byteLength);
	blob.set(nonce, 0);
	blob.set(new Uint8Array(ciphertext), nonce.length);
	let binary = "";
	for (const b of blob) binary += String.fromCharCode(b);
	return btoa(binary);
}

describe("generateForkSignInUrl", () => {
	it("embeds the user code and a random key only in the URL fragment", () => {
		const { encryptionKey, signInUrl } = generateForkSignInUrl("ABCD1234");
		expect(encryptionKey).toHaveLength(32);

		const url = new URL(signInUrl);
		expect(url.origin).toBe("https://account.proton.me");
		expect(url.pathname).toBe("/desktop/login");
		expect(url.searchParams.get("app")).toBe("drive");
		// The payload must live in the fragment, never the query string or path — it's
		// never sent to any server.
		expect(url.search).not.toContain("payload");
		const payload = decodeURIComponent(url.hash.replace(/^#payload=/, ""));
		const [version, userCode, base64Key, clientId] = payload.split(":");
		expect(version).toBe("0");
		expect(userCode).toBe("ABCD1234");
		expect(clientId).toBe("external-drive");
		expect(base64Key).toBeTruthy();
	});

	it("generates a different key on every call", () => {
		const a = generateForkSignInUrl("X");
		const b = generateForkSignInUrl("X");
		expect(a.encryptionKey).not.toEqual(b.encryptionKey);
	});
});

describe("decryptForkKeyPassword", () => {
	it("round-trips a keyPassword through AES-256-GCM", async () => {
		const { encryptionKey } = generateForkSignInUrl("X");
		const encoded = await encryptForkPayload(encryptionKey, "the-real-key-password");
		await expect(decryptForkKeyPassword(encryptionKey, encoded)).resolves.toBe("the-real-key-password");
	});

	it("rejects a payload encrypted with a different key", async () => {
		const { encryptionKey } = generateForkSignInUrl("X");
		const otherKey = crypto.getRandomValues(new Uint8Array(32));
		const encoded = await encryptForkPayload(otherKey, "secret");
		await expect(decryptForkKeyPassword(encryptionKey, encoded)).rejects.toThrow();
	});

	it("rejects a too-short payload", async () => {
		const { encryptionKey } = generateForkSignInUrl("X");
		await expect(decryptForkKeyPassword(encryptionKey, btoa("short"))).rejects.toThrow("malformed payload");
	});
});

describe("sessionForksInit", () => {
	it("returns the selector and user code on success", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ Code: 1000, Selector: "sel", UserCode: "UC" }));
		await expect(sessionForksInit()).resolves.toEqual({ Code: 1000, Selector: "sel", UserCode: "UC" });
	});

	it("throws on a non-200 response", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ Error: "nope" }, { status: 500 }));
		await expect(sessionForksInit()).rejects.toThrow("could not be started");
	});

	it("throws on a malformed 200 response", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ Code: 1000 }));
		await expect(sessionForksInit()).rejects.toThrow("invalid init response");
	});
});

describe("sessionForksStatus", () => {
	it("returns notReady on a 422 (user hasn't finished signing in)", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({}, { status: 422 }));
		await expect(sessionForksStatus("sel")).resolves.toEqual({ notReady: true });
	});

	it("returns the resolved fork on success", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ Code: 1000, Payload: "p", UID: "u", AccessToken: "a", RefreshToken: "r" }),
		);
		await expect(sessionForksStatus("sel")).resolves.toEqual({
			Code: 1000,
			Payload: "p",
			UID: "u",
			AccessToken: "a",
			RefreshToken: "r",
		});
	});

	it("throws on an unexpected non-200/422 status", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({}, { status: 400 }));
		await expect(sessionForksStatus("sel")).rejects.toThrow("status check failed");
	});
});
