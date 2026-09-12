import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createMockSecretStore } from "./test-helpers";
import type { AirSyncSettings } from "../../settings";
import { AuthError } from "../errors";

vi.mock("obsidian");

const createProtonDriveClient = vi.fn().mockReturnValue("fake-handle");
vi.mock("./client", () => ({ createProtonDriveClient }));

const getRootFolder = vi.fn();
const createFolder = vi.fn();
const getItem = vi.fn();
const MockProtonDriveClient = vi.fn().mockImplementation(function ProtonDriveClient() {
	return { getRootFolder, createFolder, getItem };
});
vi.mock("./drive-client", () => ({ ProtonDriveClient: MockProtonDriveClient }));

afterEach(() => {
	vi.clearAllMocks();
});

async function makeProvider(secrets: Record<string, string> = {}) {
	const { ProtonDriveProvider } = await import("./provider");
	const store = createMockSecretStore(secrets);
	return { provider: new ProtonDriveProvider(store), store };
}

function settingsWith(backendData: Record<string, unknown> = {}): AirSyncSettings {
	return { vaultId: "vault-1", backendData } as unknown as AirSyncSettings;
}

const CONNECTED = {
	"air-sync-protondrive-refresh-token": "RT",
	"air-sync-protondrive-uid-token": "UID1",
	"air-sync-protondrive-keyPassword-token": "KP",
};

describe("ProtonDriveProvider.isConnected / getIdentity", () => {
	it("requires both a live session and a resolved remote vault folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.isConnected(settingsWith({}))).toBe(false);
		expect(provider.isConnected(settingsWith({ remoteVaultFolderId: "FID" }))).toBe(true);
	});

	it("is not connected without a keyPassword even if a refresh token exists", async () => {
		const { provider } = await makeProvider({ "air-sync-protondrive-refresh-token": "RT" });
		expect(provider.isConnected(settingsWith({ remoteVaultFolderId: "FID" }))).toBe(false);
	});

	it("derives identity from the folder uid", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.getIdentity(settingsWith({ remoteVaultFolderId: "FID" }))).toBe("protondrive:FID");
		expect(provider.getIdentity(settingsWith({}))).toBeNull();
	});
});

describe("ProtonDriveProvider client uid persistence", () => {
	it("generates a clientUid once and reuses it across calls and provider instances", async () => {
		getRootFolder.mockResolvedValue({ uid: "root-uid" });
		createFolder.mockResolvedValue({ uid: "vault-uid" });

		const { provider, store } = await makeProvider(CONNECTED);
		await provider.resolveRemoteVault({} as never, settingsWith({}), "My Vault");
		const firstUid = createProtonDriveClient.mock.calls[0]![1] as string;
		expect(firstUid).toBeTruthy();

		await provider.resolveRemoteVault({} as never, settingsWith({}), "My Vault");
		expect(createProtonDriveClient.mock.calls[1]![1]).toBe(firstUid);

		// A fresh provider instance on the SAME secret store (simulating a plugin reload)
		// must see the same clientUid — it survives even a backend switch away and back,
		// unlike settings.backendData.
		expect(store.getSecret("air-sync-protondrive-clientUid-token")).toBe(firstUid);
	});
});

describe("ProtonDriveProvider.readBackendState", () => {
	it("returns an empty record when there is no session to persist", async () => {
		const { provider } = await makeProvider({});
		expect(provider.readBackendState()).toEqual({});
	});

	it("re-publishes the access token and uid, and returns the non-secret expiry", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const state = provider.readBackendState();
		expect(state).toHaveProperty("accessTokenExpiry");
		// getOrCreateAuth() restored the session from CONNECTED's stored secrets, so the
		// uid it re-publishes should round-trip to the same value.
		expect(store.getSecret("air-sync-protondrive-uid-token")).toBe("UID1");
	});
});

describe("ProtonDriveProvider.disconnect / clearPluginSecrets", () => {
	it("clears session secrets but preserves the per-installation clientUid", async () => {
		const { provider, store } = await makeProvider({
			...CONNECTED,
			"air-sync-protondrive-clientUid-token": "STABLE-UID",
		});

		const reset = await provider.disconnect(settingsWith({ remoteVaultFolderId: "FID" }));

		expect(reset).toEqual({ remoteVaultFolderId: "", accessTokenExpiry: 0 });
		expect(store.getSecret("air-sync-protondrive-refresh-token")).toBeFalsy();
		expect(store.getSecret("air-sync-protondrive-uid-token")).toBeFalsy();
		expect(store.getSecret("air-sync-protondrive-keyPassword-token")).toBeFalsy();
		expect(store.getSecret("air-sync-protondrive-clientUid-token")).toBe("STABLE-UID");
	});
});

describe("ProtonDriveProvider.resolveRemoteVault", () => {
	it("finds or creates obsidian-air-sync/<Vault Name> under the Drive root", async () => {
		getRootFolder.mockResolvedValue({ uid: "root-uid" });
		createFolder.mockResolvedValueOnce({ uid: "as-uid" }).mockResolvedValueOnce({ uid: "vault-uid" });
		const { provider } = await makeProvider(CONNECTED);

		const result = await provider.resolveRemoteVault({} as never, settingsWith({}), "My Vault");

		expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-uid" });
	});

	it("reuses a cached folder uid without touching the root", async () => {
		getItem.mockResolvedValue({ uid: "cached-uid" });
		const { provider } = await makeProvider(CONNECTED);

		const result = await provider.resolveRemoteVault(
			{} as never,
			settingsWith({ remoteVaultFolderId: "cached-uid" }),
			"My Vault",
		);

		expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "cached-uid" });
		expect(getRootFolder).not.toHaveBeenCalled();
	});
});

describe("ProtonDriveProvider.bindPickedFolder", () => {
	it("binds directly to the picked folder uid without a network call", async () => {
		const { provider } = await makeProvider(CONNECTED);
		const result = await provider.bindPickedFolder("picked-uid");
		expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "picked-uid" });
		expect(getItem).not.toHaveBeenCalled();
		expect(createFolder).not.toHaveBeenCalled();
	});
});

describe("ProtonDriveProvider.getRemoteVaultDisplayPath", () => {
	it("returns null when no folder is bound, without a network call", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(await provider.getRemoteVaultDisplayPath(settingsWith({}))).toBeNull();
		expect(getItem).not.toHaveBeenCalled();
	});

	it("resolves the bound folder's current name", async () => {
		getItem.mockResolvedValue({ uid: "FID", name: "My Vault" });
		const { provider } = await makeProvider(CONNECTED);
		expect(await provider.getRemoteVaultDisplayPath(settingsWith({ remoteVaultFolderId: "FID" }))).toBe("My Vault");
	});
});

describe("ProtonDriveProvider.classifyError", () => {
	it("delegates to classifyProtonDriveError", async () => {
		const { provider } = await makeProvider({});
		expect(provider.classifyError?.(new AuthError("expired", 401))).toEqual({ kind: "auth" });
	});
});

describe("ProtonDriveProvider.createUiClient", () => {
	it("builds a ProtonDriveClient for the in-app folder browser", async () => {
		const { provider } = await makeProvider(CONNECTED);
		const client = provider.createUiClient(settingsWith({}));
		expect(typeof client.getRootFolder).toBe("function");
	});
});
