// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { App } from "../../platform/obsidian";
import type { IBackendProvider } from "../backend";
import { getBackendData } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import { ProtonDriveSettingsRenderer } from "../../ui/protondrive-settings";
import { METADATA_CACHE_VERSION, MetadataStore } from "../../store/metadata-store";
import {
	clearBackendSecrets,
	getBackendSecret,
	hasBackendSecret,
	setBackendSecret,
} from "../token-store";
import { classifyProtonDriveError } from "./errors";
import { resolveProtonDriveRemoteVault } from "./remote-vault";
import { createProtonDriveClient } from "./client";
import { ProtonDriveClient, type ProtonDriveNode } from "./drive-client";
import { ProtonDriveFs } from "./index";
import { PROTON_DRIVE_BACKEND_TYPE, ProtonDriveAuthProvider } from "./auth";

/** Secrets cleared on disconnect. `clientUid` is deliberately NOT here — see {@link getOrCreateClientUid}. */
const PROTON_DRIVE_SECRET_NAMES = ["refresh", "access", "uid", "keyPassword"];

/** Proton Drive's slice of the active-backend `backendData` bag (tokens live in SecretStorage). */
export interface ProtonDriveBackendData {
	remoteVaultFolderId: string;
	accessTokenExpiry: number;
}

const DEFAULT_PROTON_DRIVE_DATA: ProtonDriveBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
};

function getProtonDriveData(settings: AirSyncSettings): ProtonDriveBackendData {
	return { ...DEFAULT_PROTON_DRIVE_DATA, ...getBackendData<ProtonDriveBackendData>(settings) };
}

/**
 * Proton Drive backend provider. Unlike Google Drive/OneDrive/Dropbox, auth is
 * session-fork (not OAuth token refresh) and the account has no app-folder
 * scoping — sync binds to an explicit folder anywhere in "My files" (default
 * `obsidian-air-sync/<Vault Name>`, or a folder picked via
 * `ui/protondrive-folder-picker.ts`'s in-app browser). See
 * docs/protondrive-backend.md for the full addressing/auth model.
 */
export class ProtonDriveProvider implements IBackendProvider {
	readonly type = PROTON_DRIVE_BACKEND_TYPE;
	readonly displayName = "Proton Drive";
	readonly auth: ProtonDriveAuthProvider;

	constructor(private readonly secretStore: ISecretStore) {
		this.auth = new ProtonDriveAuthProvider(secretStore);
	}

	/**
	 * A stable, per-installation identifier the SDK requires (`config.clientUid`,
	 * unrelated to the session's own uid — see `client.ts`). Stored as a plugin
	 * secret so it survives both a disconnect/reconnect AND a switch away to a
	 * different backend and back (unlike `settings.backendData`, which is cleared
	 * on every backend switch) — Proton correlates it across the client's whole
	 * lifetime on this installation, not just one session.
	 */
	private getOrCreateClientUid(): string {
		const existing = getBackendSecret(this.secretStore, this.type, "clientUid");
		if (existing) return existing;
		const clientUid = crypto.randomUUID();
		setBackendSecret(this.secretStore, this.type, "clientUid", clientUid);
		return clientUid;
	}

	/** Build a ProtonDriveClient wrapper on the shared session auth. */
	private makeClient(logger?: Logger): ProtonDriveClient {
		const auth = this.auth.getOrCreateAuth();
		const handle = createProtonDriveClient(auth, this.getOrCreateClientUid(), logger);
		return new ProtonDriveClient(handle);
	}

	/** The client shape the in-app folder browser needs (see `ui/protondrive-folder-picker.ts`). */
	createUiClient(_settings: AirSyncSettings, logger?: Logger): ProtonDriveClient {
		return this.makeClient(logger);
	}

	/** Open the per-target IndexedDB cache store, or null if no folder is bound. */
	private metadataStoreFor(settings: AirSyncSettings): MetadataStore<ProtonDriveNode> | null {
		const data = getProtonDriveData(settings);
		if (!data.remoteVaultFolderId) return null;
		return new MetadataStore<ProtonDriveNode>(`${settings.vaultId}-${data.remoteVaultFolderId}`, {
			dbNamePrefix: "air-sync-protondrive",
			version: METADATA_CACHE_VERSION,
		});
	}

	createFs(_app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = getProtonDriveData(settings);
		if (!this.auth.isAuthenticated(settings.backendData ?? {}) || !data.remoteVaultFolderId) return null;

		const client = this.makeClient(logger);
		return new ProtonDriveFs(client, data.remoteVaultFolderId, logger, this.metadataStoreFor(settings) ?? undefined);
	}

	isConnected(settings: AirSyncSettings): boolean {
		return this.auth.isAuthenticated(settings.backendData ?? {}) && !!getProtonDriveData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const data = getProtonDriveData(settings);
		return data.remoteVaultFolderId ? `${this.type}:${data.remoteVaultFolderId}` : null;
	}

	classifyError(err: unknown) {
		return classifyProtonDriveError(err);
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new ProtonDriveSettingsRenderer();
	}

	/**
	 * Re-publish the access token (refreshed reactively, see `auth.ts`) and the
	 * session uid — `performRefresh` can rotate the uid but only ever mutates it
	 * in memory, so this keeps the persisted copy from drifting stale across a
	 * plugin reload. `keyPassword`/`refresh` are already published synchronously
	 * (see `ProtonDriveAuthProvider.startAuth`); nothing else here is durable.
	 */
	readBackendState(): Record<string, unknown> {
		if (!hasBackendSecret(this.secretStore, this.type, "refresh")) return {};
		const auth = this.auth.getOrCreateAuth();
		const tokens = auth.getTokenState();
		setBackendSecret(this.secretStore, this.type, "access", tokens.accessToken);
		setBackendSecret(this.secretStore, this.type, "uid", auth.getUid());
		return { accessTokenExpiry: tokens.accessTokenExpiry };
	}

	/**
	 * Find or create `obsidian-air-sync/<Vault Name>` (or reuse the cached folder).
	 * Invoked explicitly when the user binds the default folder — not automatically
	 * on connect.
	 */
	async resolveRemoteVault(
		_app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = getProtonDriveData(settings);
		const client = this.makeClient(logger);
		return resolveProtonDriveRemoteVault(client, vaultName, data.remoteVaultFolderId || undefined, logger);
	}

	/**
	 * Bind the vault directly to an arbitrary folder picked via the in-app browser
	 * (`ui/protondrive-folder-picker.ts`). Full-drive scope means there is no fixed
	 * app-folder subset to find-or-create a name under (unlike OneDrive/Dropbox's
	 * `pendingPickedFolderPath` convention) — the modal already proved the folder is
	 * reachable by browsing to it, so this needs no further network call.
	 */
	bindPickedFolder(folderUid: string): Promise<RemoteVaultResolution> {
		return Promise.resolve({ backendUpdates: { remoteVaultFolderId: folderUid } });
	}

	/**
	 * Resolve the bound folder's current path for display, from its uid. Nothing is
	 * stored — this reflects the folder's live location. Unlike Google Drive/OneDrive,
	 * Proton Drive exposes a direct ancestor walk (`getNodeHierarchy`), but that isn't
	 * wrapped yet (not needed by any landed step) — deferred to the settings-UI step.
	 */
	async getRemoteVaultDisplayPath(settings: AirSyncSettings, logger?: Logger): Promise<string | null> {
		const data = getProtonDriveData(settings);
		if (!data.remoteVaultFolderId) return null;
		const client = this.makeClient(logger);
		const node = await client.getItem(data.remoteVaultFolderId);
		return node?.name ?? null;
	}

	disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		this.auth.revokeAuth();
		this.clearPluginSecrets();
		// The per-target IndexedDB cache + cursor is cleared by BackendManager via the
		// live FS's resetCheckpoint() (one connection, no race) — see disconnectBackend.
		return Promise.resolve({ ...DEFAULT_PROTON_DRIVE_DATA });
	}

	/**
	 * Clear the per-target checkpoint store by its settings key, without a live FS
	 * (used by disconnect when the backend had no live FS — e.g. expired auth).
	 * Best-effort: a failure must not block disconnect.
	 */
	async clearCheckpointStore(settings: AirSyncSettings): Promise<void> {
		const store = this.metadataStoreFor(settings);
		if (!store) return;
		try {
			await store.open();
			await store.clear();
			await store.close();
		} catch {
			/* non-fatal: an orphaned store is keyed by the old target and never reused */
		}
	}

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, this.type, PROTON_DRIVE_SECRET_NAMES);
	}
}
