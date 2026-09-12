import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveProtonDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../remote-vault-contract";
import type { ProtonDriveClient } from "./drive-client";
import { pdFolder } from "./test-helpers";

function createMockClient(): {
	client: ProtonDriveClient;
	getRootFolder: ReturnType<typeof vi.fn>;
	createFolder: ReturnType<typeof vi.fn>;
	getItem: ReturnType<typeof vi.fn>;
} {
	const getRootFolder = vi.fn();
	const createFolder = vi.fn();
	const getItem = vi.fn();
	const client = { getRootFolder, createFolder, getItem } as unknown as ProtonDriveClient;
	return { client, getRootFolder, createFolder, getItem };
}

describe("resolveProtonDriveRemoteVault", () => {
	let mock: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mock = createMockClient();
	});

	describe("reconnect with a cached folder uid", () => {
		it("reuses the cached folder after verifying it exists, without touching the root", async () => {
			mock.getItem.mockResolvedValueOnce(pdFolder("vault-folder-uid", "My Vault", "root"));

			const result = await resolveProtonDriveRemoteVault(mock.client, "My Vault", "vault-folder-uid");

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-folder-uid" });
			expect(mock.getRootFolder).not.toHaveBeenCalled();
			expect(mock.createFolder).not.toHaveBeenCalled();
		});

		it("throws a descriptive error when the cached folder is gone", async () => {
			mock.getItem.mockResolvedValueOnce(null);

			await expect(
				resolveProtonDriveRemoteVault(mock.client, "My Vault", "deleted-folder-uid"),
			).rejects.toThrow("deleted or is no longer reachable");
		});
	});

	describe("new binding by folder name", () => {
		it("creates obsidian-air-sync/<Vault Name> under the Drive root", async () => {
			mock.getRootFolder.mockResolvedValueOnce(pdFolder("root-uid", "", ""));
			mock.createFolder.mockResolvedValueOnce(pdFolder("as-uid", REMOTE_VAULT_ROOT, "root-uid"));
			mock.createFolder.mockResolvedValueOnce(pdFolder("vault-uid", "My Vault", "as-uid"));

			const result = await resolveProtonDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-uid" });
			expect(mock.createFolder).toHaveBeenNthCalledWith(1, "root-uid", REMOTE_VAULT_ROOT);
			expect(mock.createFolder).toHaveBeenNthCalledWith(2, "as-uid", "My Vault");
		});

		it("reuses an existing obsidian-air-sync/<Vault Name> folder (createFolder is idempotent)", async () => {
			mock.getRootFolder.mockResolvedValueOnce(pdFolder("root-uid", "", ""));
			mock.createFolder.mockResolvedValueOnce(pdFolder("as-uid", REMOTE_VAULT_ROOT, "root-uid"));
			mock.createFolder.mockResolvedValueOnce(pdFolder("named-uid", "My Vault", "as-uid"));

			const result = await resolveProtonDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "named-uid" });
		});
	});
});
