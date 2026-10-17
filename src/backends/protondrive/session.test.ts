import { describe, expect, it, vi } from "vitest";
import type { BackendSecretStore } from "../../backend-api";
import type { SessionTokens, StoredSession } from "./session";
import { SESSION_SECRET_KEY } from "./session";
import { SessionHandle, loadSession, parseSessionTokens, saveSession } from "./session";

function memorySecrets(): BackendSecretStore {
	const values = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(values.get(key) ?? null),
		set: (key, value) => {
			values.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			values.delete(key);
			return Promise.resolve();
		},
	};
}

function tokens(generation: number): SessionTokens {
	const parsed = parseSessionTokens({ UID: "uid", AccessToken: `at-${generation}`, RefreshToken: `rt-${generation}` });
	if (!parsed) throw new Error("fixture");
	return parsed;
}

function session(generation: number): StoredSession {
	return { ...tokens(generation), sealedKeyPassword: "sealed-blob" };
}

describe("SessionHandle.refresh", () => {
	it("adopts tokens another connection already rotated instead of replaying the old refresh token", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);
		await saveSession(secrets, session(2));
		const refresher = vi.fn();

		await handle.refresh(session(1).accessToken, refresher);

		expect(refresher).not.toHaveBeenCalled();
		expect(handle.current.accessToken).toBe(session(2).accessToken);
	});

	it("refreshes once for concurrent 401s and persists the rotated tokens with the key password", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);
		const refresher = vi.fn().mockResolvedValue(tokens(2));

		await Promise.all([
			handle.refresh(session(1).accessToken, refresher),
			handle.refresh(session(1).accessToken, refresher),
		]);

		expect(refresher).toHaveBeenCalledTimes(1);
		expect(await loadSession(secrets)).toEqual(session(2));
	});

	it("fails with an auth error and keeps the stored session when Proton rejects the refresh token", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);

		await expect(handle.refresh(session(1).accessToken, () => Promise.resolve(null))).rejects.toMatchObject({ kind: "auth" });
		expect(await loadSession(secrets)).toEqual(session(1));
	});

	it("refuses to open without a stored session", async () => {
		await expect(SessionHandle.open(memorySecrets())).rejects.toMatchObject({ kind: "auth" });
	});
});

describe("stored session shape (local key)", () => {
	it("local key: keeps the sealed key password across a refresh and never a plaintext one", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);
		await handle.refresh(session(1).accessToken, () => Promise.resolve(tokens(2)));
		const raw = await secrets.get(SESSION_SECRET_KEY);
		expect(JSON.parse(raw ?? "{}")).toEqual({ uid: "uid", accessToken: "at-2", refreshToken: "rt-2", sealedKeyPassword: "sealed-blob" });
		expect(raw).not.toContain("keyPassword\"");
	});

	it("local key: treats an unmarked plaintext key password (the old shape) as no session", async () => {
		const secrets = memorySecrets();
		await secrets.set(SESSION_SECRET_KEY, JSON.stringify({ uid: "uid", accessToken: "at", refreshToken: "rt", keyPassword: "kp" }));
		expect(await loadSession(secrets)).toBeNull();
		await expect(SessionHandle.open(secrets)).rejects.toMatchObject({ kind: "auth" });
	});

	it("local key: accepts the explicitly marked plaintext fallback", async () => {
		const secrets = memorySecrets();
		const fallback = { uid: "uid", accessToken: "at", refreshToken: "rt", keyPassword: "kp", keyPasswordAtRest: "plaintext" };
		await secrets.set(SESSION_SECRET_KEY, JSON.stringify(fallback));
		expect(await loadSession(secrets)).toEqual(fallback);
	});

	it("local key: a sign-in handle refreshes in memory only", async () => {
		const secrets = memorySecrets();
		const handle = SessionHandle.forSignIn(secrets, tokens(1));
		await handle.refresh(tokens(1).accessToken, () => Promise.resolve(tokens(2)));
		expect(handle.tokens.accessToken).toBe("at-2");
		expect(await secrets.get(SESSION_SECRET_KEY)).toBeNull();
	});
});
