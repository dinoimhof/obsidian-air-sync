// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { REMOTE_VAULT_ROOT } from "../remote-vault-contract";
import type { ProtonDriveClient } from "./drive-client";

/**
 * Resolve or create this vault's remote folder in Proton Drive, by convention.
 *
 * Layout: "My files" root / obsidian-air-sync / <Vault Name>
 *
 * Unlike OneDrive/Dropbox (App-Folder scoped, so "the root" IS the app's own
 * folder), Proton Drive has no OAuth app-folder scoping — this walks down from
 * the account's real Drive root, exactly like Google Drive's `resolveGoogleDriveRemoteVault`.
 * `ProtonDriveClient.createFolder` is already idempotent (find-or-create in one
 * call), so there is no separate `findChildByName` step here.
 *
 * Order:
 *  1. cached uid present → verify it still exists, keep it.
 *  2. otherwise find-or-create obsidian-air-sync/<Vault Name> and bind it.
 */
export async function resolveProtonDriveRemoteVault(
	client: ProtonDriveClient,
	vaultName: string,
	cachedFolderUid: string | undefined,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	if (cachedFolderUid) {
		return resolveLinked(client, cachedFolderUid);
	}

	const root = await client.getRootFolder();
	const rootFolder = await client.createFolder(root.uid, REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { uid: rootFolder.uid });

	return resolveByName(client, rootFolder.uid, vaultName, logger);
}

async function resolveLinked(client: ProtonDriveClient, cachedFolderUid: string): Promise<RemoteVaultResolution> {
	const node = await client.getItem(cachedFolderUid);
	if (!node) {
		throw new Error(`Failed to access remote vault folder: it was deleted or is no longer reachable (uid: ${cachedFolderUid})`);
	}
	return { backendUpdates: { remoteVaultFolderId: node.uid } };
}

async function resolveByName(
	client: ProtonDriveClient,
	rootFolderUid: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	const folder = await client.createFolder(rootFolderUid, vaultName);
	logger?.info("Bound remote vault by name", { folderUid: folder.uid, vaultName });
	return { backendUpdates: { remoteVaultFolderId: folder.uid } };
}
