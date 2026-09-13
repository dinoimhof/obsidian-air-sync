import { describe, it, expect, beforeAll, vi } from "vitest";
import type { ISecretStore } from "./secret-store";
import type { AirSyncSettings } from "../settings";
import type { App } from "obsidian";
import { remoteBackendFamilyOf } from "../../tests/fs/contracts/remote-backend-family";
import { GoogleDriveFs } from "./googledrive";

vi.mock("obsidian");

// Proton Drive's provider module graph reaches `@protontech/drive-sdk`/
// `@protontech/crypto` (real, unmocked) via `fs/protondrive/client.ts` and
// `fs/protondrive/drive-client.ts` — those packages ship raw TS gated behind a
// "browser" export condition and execute browser-only code (WebCrypto/openpgp) at
// import time, which crashes under vitest's plain Node test environment (see
// docs/protondrive-backend.md). This test only needs the real `ProtonDriveFs`
// CLASS to construct on SOME client object (to check its checkpoint/family
// pairing), never the real SDK, so stub the two modules that pull it in.
vi.mock("./protondrive/client", () => ({ createProtonDriveClient: () => "fake-handle" }));
vi.mock("./protondrive/drive-client", () => ({ ProtonDriveClient: class {} }));

// A secret store that satisfies any backend's token lookup, so each provider's
// createFs() can build its FS for the pairing check below (createFs returns null
// without a refresh token). `key-password` is Proton Drive-specific (see
// `ProtonDriveAuthProvider.isAuthenticated`).
const connectedSecretStore: ISecretStore = {
	getSecret: (id: string) =>
		id.includes("refresh") ? "RT"
			: id.includes("access") ? "AT"
				: id.includes("key-password") ? "KP"
					: null,
	setSecret: () => {},
};

// A "connected" settings: a bound folder + a future token expiry, plus custom-OAuth
// fields so the custom backend builds too. Generic enough for every Google Drive-family
// backend; extend it when a backend needs more to produce a non-null createFs().
function connectedSettings(): AirSyncSettings {
	return {
		vaultId: "vault-1",
		backendData: {
			remoteVaultFolderId: "FID",
			accessTokenExpiry: Date.now() + 3_600_000,
			customClientId: "CID",
			customClientSecret: "CS",
		},
	} as unknown as AirSyncSettings;
}

const mockApp = {} as App;

describe("backend registry ↔ checkpoint-store pairing", () => {
	let getAllBackendProviders: typeof import("./registry").getAllBackendProviders;

	beforeAll(async () => {
		const registry = await import("./registry");
		getAllBackendProviders = registry.getAllBackendProviders;
		registry.initRegistry(connectedSecretStore);
	});

	// The FS-side incremental checkpoint (`fs.checkpoint`) and the provider-side
	// `clearCheckpointStore` are two halves of one durable store: the live FS clears it
	// via resetCheckpoint, but the disconnect/switch path with NO live FS (expired auth)
	// falls back to `provider.clearCheckpointStore(settings)`. They live on different
	// types joined only at runtime (provider.createFs), so TS can't enforce that a
	// checkpoint-bearing backend also ships the by-key clear. Pin it here: a backend that
	// forgets clearCheckpointStore would silently orphan its store on a no-live-FS
	// disconnect, leaving a stale checkpoint to mislead a later reconnect.
	it("registers the built-in and custom-app variants of every backend", () => {
		const types = getAllBackendProviders().map((p) => p.type);
		expect(types).toEqual(
			expect.arrayContaining([
				"googledrive", "googledrive-custom",
				"onedrive", "onedrive-custom",
				"dropbox", "dropbox-custom",
				"protondrive",
			]),
		);
	});

	it("a backend ships clearCheckpointStore iff its FS carries a checkpoint", () => {
		const providers = getAllBackendProviders();
		expect(providers.length).toBeGreaterThan(0);

		for (const provider of providers) {
			const fs = provider.createFs(mockApp, connectedSettings(), undefined);
			expect(
				fs,
				`createFs returned null for "${provider.type}" — extend connectedSettings() ` +
					`so this backend builds an FS and the pairing can be checked.`,
			).not.toBeNull();

			const hasCheckpoint = !!fs?.checkpoint;
			const hasClear = !!provider.clearCheckpointStore;
			expect(
				hasClear,
				`Backend "${provider.type}": fs.checkpoint=${hasCheckpoint} but ` +
					`clearCheckpointStore=${hasClear}. A checkpoint-bearing backend MUST implement ` +
					`clearCheckpointStore (the no-live-FS disconnect clears the per-target store by ` +
					`key); a backend without a checkpoint must not declare it.`,
			).toBe(hasCheckpoint);

			void fs?.close?.();
		}
	});

	it("every registered provider creates a filesystem covered by a remote contract family", () => {
		for (const provider of getAllBackendProviders()) {
			const fs = provider.createFs(mockApp, connectedSettings(), undefined);
			expect(fs, `createFs returned null for "${provider.type}"`).not.toBeNull();
			expect(
				fs && remoteBackendFamilyOf(fs),
				`Backend "${provider.type}" creates an uncontracted filesystem implementation`,
			).toBeDefined();
			void fs?.close?.();
		}
	});

	it("does not treat an uncatalogued subclass as its parent contract family", () => {
		class UncontractedGoogleDriveFs extends GoogleDriveFs {}
		const fs = Object.create(UncontractedGoogleDriveFs.prototype) as GoogleDriveFs;
		expect(remoteBackendFamilyOf(fs)).toBeUndefined();
	});
});
