import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";
import { AuthError } from "../errors";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const SECRET_KEYS = {
	refresh: "air-sync-protondrive-refresh-token",
	access: "air-sync-protondrive-access-token",
	uid: "air-sync-protondrive-uid-token",
	keyPassword: "air-sync-protondrive-keyPassword-token",
};

async function makeProvider(secrets: Record<string, string> = {}) {
	const { ProtonDriveAuthProvider } = await import("./auth");
	const store = createMockSecretStore(secrets);
	const provider = new ProtonDriveAuthProvider(store, undefined, () => Promise.resolve());
	return { provider, store };
}

describe("ProtonDriveAuthProvider.isAuthenticated", () => {
	it("is false with no stored session", async () => {
		const { provider } = await makeProvider();
		expect(provider.isAuthenticated({})).toBe(false);
	});

	it("is false with a refresh token but no keyPassword (can't decrypt anything yet)", async () => {
		const { provider } = await makeProvider({ [SECRET_KEYS.refresh]: "R" });
		expect(provider.isAuthenticated({})).toBe(false);
	});

	it("is true once both a refresh token and a keyPassword are stored", async () => {
		const { provider } = await makeProvider({ [SECRET_KEYS.refresh]: "R", [SECRET_KEYS.keyPassword]: "KP" });
		expect(provider.isAuthenticated({})).toBe(true);
	});
});

describe("ProtonDriveAuthProvider.startAuth", () => {
	function stubBrowser() {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });
		return () => openedUrl;
	}

	it("opens the sign-in URL, polls through a not-ready fork, and persists the full session", async () => {
		const getOpenedUrl = stubBrowser();

		// Fix the fork's encryption key so the payload can be pre-built (with sleep
		// mocked to resolve instantly, there's no yield point to intercept the real
		// URL mid-flight and build the payload only once startAuth is already running).
		const fixedKey = new Uint8Array(32).fill(7);
		const realGetRandomValues = crypto.getRandomValues.bind(crypto);
		vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
			if (array instanceof Uint8Array && array.length === 32) {
				array.set(fixedKey);
				return array;
			}
			return realGetRandomValues(array);
		});

		const nonce = Uint8Array.from(realGetRandomValues(new Uint8Array(12)));
		const cryptoKey = await crypto.subtle.importKey("raw", Uint8Array.from(fixedKey), { name: "AES-GCM" }, false, [
			"encrypt",
		]);
		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode("fork"), tagLength: 128 },
			cryptoKey,
			new TextEncoder().encode(JSON.stringify({ keyPassword: "the-key-password" })),
		);
		const blob = new Uint8Array(nonce.length + ciphertext.byteLength);
		blob.set(nonce, 0);
		blob.set(new Uint8Array(ciphertext), nonce.length);
		let binary = "";
		for (const b of blob) binary += String.fromCharCode(b);
		const payload = btoa(binary);

		const requestSpy = await spyRequestUrl();
		requestSpy.mockResolvedValueOnce(mockRes({ Code: 1000, Selector: "sel", UserCode: "UC" })); // sessionForksInit
		requestSpy.mockResolvedValueOnce(mockRes({}, { status: 422 })); // not ready yet
		requestSpy.mockResolvedValueOnce(
			mockRes({ Code: 1000, Payload: payload, UID: "the-uid", AccessToken: "AT", RefreshToken: "RT" }),
		);

		const { provider, store } = await makeProvider();
		const out = await provider.startAuth({});

		expect(getOpenedUrl()).toContain("account.proton.me");

		expect(store.getSecret(SECRET_KEYS.refresh)).toBe("RT");
		expect(store.getSecret(SECRET_KEYS.access)).toBe("AT");
		expect(store.getSecret(SECRET_KEYS.uid)).toBe("the-uid");
		expect(store.getSecret(SECRET_KEYS.keyPassword)).toBe("the-key-password");
		expect(typeof out.accessTokenExpiry).toBe("number");

		const initReq = requestSpy.mock.calls[0]![0] as RequestUrlParam;
		expect(initReq.url).toBe("https://drive-api.proton.me/auth/v4/sessions/forks");
	});

	it("times out if the fork never resolves", async () => {
		stubBrowser();
		const requestSpy = await spyRequestUrl();
		requestSpy.mockResolvedValueOnce(mockRes({ Code: 1000, Selector: "sel", UserCode: "UC" }));
		requestSpy.mockResolvedValue(mockRes({}, { status: 422 })); // never resolves

		const { ProtonDriveAuthProvider } = await import("./auth");
		const store = createMockSecretStore();
		// Instant sleep, but the loop's own elapsed-time check still fires since
		// Date.now() advances in real time — simulate that by returning a resolved
		// promise so the loop spins fast, then assert it eventually gives up.
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => {
			now += 60_000; // jump 1 minute per poll tick
			return now;
		});
		const provider = new ProtonDriveAuthProvider(store, undefined, () => Promise.resolve());

		let caught: unknown;
		try {
			await provider.startAuth({});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AuthError);
		expect((caught as Error).message).toMatch(/timed out/);
	});
});

describe("ProtonDriveAuthProvider.getOrCreateAuth", () => {
	it("rehydrates a previously stored session with no user interaction", async () => {
		const { provider } = await makeProvider({
			[SECRET_KEYS.refresh]: "RT",
			[SECRET_KEYS.access]: "AT",
			[SECRET_KEYS.uid]: "UID",
			[SECRET_KEYS.keyPassword]: "KP",
		});
		const auth = provider.getOrCreateAuth();
		expect(auth.getUid()).toBe("UID");
		expect(auth.getKeyPassword()).toBe("KP");
		expect(await auth.getAccessToken()).toBe("AT");
	});

	it("returns the same instance on repeated calls", async () => {
		const { provider } = await makeProvider();
		expect(provider.getOrCreateAuth()).toBe(provider.getOrCreateAuth());
	});
});

describe("ProtonDriveAuth token refresh", () => {
	it("refreshes using the refresh token and persists the rotated one", async () => {
		const { provider, store } = await makeProvider({
			[SECRET_KEYS.refresh]: "RT",
			[SECRET_KEYS.access]: "AT",
			[SECRET_KEYS.uid]: "UID",
			[SECRET_KEYS.keyPassword]: "KP",
		});
		const auth = provider.getOrCreateAuth();
		// Force a refresh regardless of the assumed-lifetime expiry.
		const requestSpy = await spyRequestUrl();
		requestSpy.mockResolvedValue(mockRes({ UID: "UID", AccessToken: "AT2", RefreshToken: "RT2" }));

		const token = await auth.getAccessToken(true);

		expect(token).toBe("AT2");
		expect(store.getSecret(SECRET_KEYS.refresh)).toBe("RT2");
		const body = JSON.parse((requestSpy.mock.calls[0]![0] as RequestUrlParam).body as string) as Record<string, unknown>;
		expect(body).toEqual({ ResponseType: "token", GrantType: "refresh_token", RefreshToken: "RT" });
	});

	it("throws AuthError on a 401 refresh failure", async () => {
		const { provider } = await makeProvider({
			[SECRET_KEYS.refresh]: "RT",
			[SECRET_KEYS.keyPassword]: "KP",
		});
		const auth = provider.getOrCreateAuth();
		(await spyRequestUrl()).mockResolvedValue(mockRes({ error: "expired" }, { status: 401 }));

		await expect(auth.getAccessToken(true)).rejects.toBeInstanceOf(AuthError);
	});

	it("throws a plain error on a 5xx refresh failure (not auth-classified)", async () => {
		const { provider } = await makeProvider({
			[SECRET_KEYS.refresh]: "RT",
			[SECRET_KEYS.keyPassword]: "KP",
		});
		const auth = provider.getOrCreateAuth();
		(await spyRequestUrl()).mockResolvedValue(mockRes({}, { status: 500 }));

		await expect(auth.getAccessToken(true)).rejects.not.toBeInstanceOf(AuthError);
	});
});
