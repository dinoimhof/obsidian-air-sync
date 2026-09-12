// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { FileEntity } from "../types";
import type { MetadataStore } from "../../store/metadata-store";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../remote-vault-contract";
import { sha256 } from "../../utils/hash";
import { normalizeSyncPath, validateRename } from "../../utils/path";
import { CachingRemoteFs } from "../caching/remote-fs";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { resolveDetachedIdPath } from "../priority-observation";
import type { ProtonDriveClient, ProtonDriveNode } from "./drive-client";
import { ProtonDriveMetadataCache, protonDriveNodeToEntity } from "./metadata-cache";
import { applyProtonDriveEvents } from "./incremental-sync";

/**
 * IFileSystem implementation backed by Proton Drive.
 *
 * The crash-safe cache/checkpoint machinery (ADR 0001) lives in
 * {@link CachingRemoteFs}; this subclass supplies Proton Drive's seams (the
 * `iterateEvents` cursor, a recursive full listing, download/trash by uid,
 * root-liveness) and the mutating ops (write/mkdir/rename). Nodes are addressed
 * by their stable, opaque `uid` — exactly like OneDrive/Google Drive — so a
 * remote move/rename of the vault folder needs no migration.
 */
export class ProtonDriveFs extends CachingRemoteFs<ProtonDriveNode> {
	readonly name = "protondrive";
	private client: ProtonDriveClient;

	constructor(
		client: ProtonDriveClient,
		rootFolderId: string,
		logger?: Logger,
		metadataStore?: MetadataStore<ProtonDriveNode>,
	) {
		super(rootFolderId, new ProtonDriveMetadataCache(rootFolderId, logger), metadataStore, logger);
		this.client = client;
	}

	// ── Proton Drive-specific seams ──

	protected getStartCursor(): Promise<string> {
		return this.client.getStartCursor(this.rootFolderId);
	}

	protected fullList(): Promise<ProtonDriveNode[]> {
		return this.client.fullList(this.rootFolderId);
	}

	protected async assertRootAlive(): Promise<void> {
		// An empty full enumeration is ambiguous (genuinely empty folder vs the sync
		// root itself trashed/gone), so confirm the root still exists before the base
		// reconciles an empty list — otherwise a cold reconcile would read every file
		// as remotely deleted and plan a mass delete_local.
		const node = await this.client.getItem(this.rootFolderId);
		if (!node) throw new Error(`Remote vault folder was deleted (uid: ${this.rootFolderId})`);
	}

	protected fetchChanges(cursor: string): Promise<IncrementalChangesResult> {
		return applyProtonDriveEvents(
			{ cache: this.cache, client: this.client, rootId: this.rootFolderId, logger: this.logger },
			cursor,
		);
	}

	protected fetchCurrentFile(nodeUid: string): Promise<ProtonDriveNode | null> {
		return this.client.getItem(nodeUid);
	}

	protected async fetchCurrentPath(path: string): Promise<ProtonDriveNode[]> {
		let parentUid = this.rootFolderId;
		const segments = path.split("/");
		for (const [index, segment] of segments.entries()) {
			const node = await this.client.getChildByName(parentUid, segment);
			if (!node) return [];
			if (index === segments.length - 1) return [node];
			if (!node.isFolder) return [];
			parentUid = node.uid;
		}
		return [];
	}

	protected resolveDetachedPath(node: ProtonDriveNode): Promise<string | null> {
		return resolveDetachedIdPath(node, this.rootFolderId, (uid) => this.fetchCurrentFile(uid), {
			id: (entry) => entry.uid,
			name: (entry) => entry.name,
			parents: (entry) => entry.parentUid ? [entry.parentUid] : undefined,
			isFolder: (entry) => entry.isFolder,
		});
	}

	protected toDetachedEntity(path: string, node: ProtonDriveNode): FileEntity {
		return { ...protonDriveNodeToEntity(path, node), pathAuthority: "actual_resolved" };
	}

	protected detachedVersionToken(node: ProtonDriveNode): string | null {
		if (node.isFolder || !node.revisionUid) return null;
		return `protondrive:${node.revisionUid}`;
	}

	protected downloadFile(nodeUid: string): Promise<ArrayBuffer> {
		return this.client.download(nodeUid);
	}

	protected deleteRemote(nodeUid: string): Promise<void> {
		return this.client.deleteItem(nodeUid);
	}

	// ── Mutating ops (addressed by uid) ──

	async write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		if (path === INTERNAL_METADATA_PATH) {
			throw new Error(`Refusing to write reserved backend path: ${path}`);
		}
		const { result: node } = await this.withCacheMutex({
			operationName: "write",
			resolve: async () => {
				const fileName = path.split("/").pop()!;
				const parentPath = ProtonDriveMetadataCache.parentPath(path);
				const parentUid = parentPath ? await this.ensureFolder(parentPath) : this.rootFolderId;
				const actualParent = parentUid === this.rootFolderId ? "" : this.cache.getPathById(parentUid);
				if (actualParent === undefined) {
					throw new Error(`Cannot resolve provider parent for "${path}"`);
				}
				const targetPath = actualParent ? `${actualParent}/${fileName}` : fileName;
				if (this.cache.isFolder(targetPath)) {
					throw new Error(`Cannot write file: "${targetPath}" is an existing directory`);
				}
				return { fileName, parentUid, existingId: this.cache.idAt(targetPath), targetPath };
			},
			// The SDK distinguishes creating a new file (`getFileUploader`, rejects a name
			// conflict) from uploading a new revision of an existing one
			// (`getFileRevisionUploader`) — unlike Graph's/Google Drive's single upsert
			// endpoint. `existingId` (resolved under the mutex, phase 1) tells us which.
			execute: (r) => r.existingId
				? this.client.uploadRevision(r.existingId, content, mtime)
				: this.client.upload(r.parentUid, r.fileName, content, mtime),
			staleGuard: (r) => ({ path: r.targetPath, expectedId: r.existingId }),
			update: (r, result) => {
				if (!this.cache.applyFileChange(result)) {
					this.cache.setFile(r.targetPath, result, "requested_echo");
				}
			},
		});

		const hash = await sha256(content);
		return { ...protonDriveNodeToEntity(path, node), pathAuthority: "requested_echo", size: content.byteLength, hash };
	}

	async mkdir(path: string): Promise<FileEntity> {
		path = normalizeSyncPath(path);
		return this.cacheMutex.run(async () => {
			await this.ensureInitialized();
			const folderUid = await this.ensureFolder(path);
			return {
				path,
				pathAuthority: "requested_echo",
				identityKey: folderUid,
				isDirectory: true,
				size: 0,
				mtime: 0,
				hash: "",
				backendMeta: { protonDriveUid: folderUid },
			};
		});
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeSyncPath(oldPath);
		newPath = normalizeSyncPath(newPath);
		validateRename(oldPath, newPath);
		await this.withCacheMutex({
			operationName: "rename",
			resolve: async () => {
				const node = this.cache.getFile(oldPath);
				if (!node) throw new Error(`File not found: ${oldPath}`);
				if (this.cache.hasFile(newPath)) throw new Error(`Destination already exists: ${newPath}`);

				const oldName = oldPath.split("/").pop()!;
				const newName = newPath.split("/").pop()!;
				const oldParentPath = ProtonDriveMetadataCache.parentPath(oldPath);
				const newParentPath = ProtonDriveMetadataCache.parentPath(newPath);

				const name = oldName !== newName ? newName : undefined;
				let newParentUid: string | undefined;
				if (oldParentPath !== newParentPath) {
					newParentUid = newParentPath ? await this.ensureFolder(newParentPath) : this.rootFolderId;
				}
				return { uid: node.uid, name, newParentUid, wasFolder: this.cache.isFolder(oldPath) };
			},
			execute: (r) => this.client.move(r.uid, r.name, r.newParentUid),
			staleGuard: (r) => ({ path: oldPath, expectedId: r.uid }),
			update: (r, result) => {
				// Mirror OneDriveFs.rename: the shared stale-guard validates only the
				// SOURCE; skip if a concurrent op landed a different item at newPath.
				const occupant = this.cache.getFile(newPath);
				if (occupant && occupant.uid !== result.uid) {
					this.logger?.warn("Skipping stale cache update for rename", { path: newPath });
					return;
				}
				this.cache.removeEntry(oldPath);
				if (!this.cache.applyFileChange(result)) {
					this.cache.setFile(newPath, result, "actual_resolved");
				}
				if (r.wasFolder) this.cache.rewriteChildPaths(oldPath, newPath);
			},
		});
	}

	/** Ensure a folder exists by path, creating parents as needed. Returns its uid. */
	private async ensureFolder(path: string): Promise<string> {
		const existing = this.cache.getFile(path);
		if (existing && this.cache.isFolder(path)) return existing.uid;

		const parts = path.split("/");
		let currentPath = "";
		let parentUid = this.rootFolderId;
		for (const part of parts) {
			const requestedPath = currentPath ? `${currentPath}/${part}` : part;
			const matchingPaths = [...(this.cache.getChildren(currentPath) ?? [])].filter((candidate) =>
				this.cache.getFile(candidate)?.name.toLowerCase() === part.toLowerCase());
			if (matchingPaths.length > 1) {
				throw new Error(`Ambiguous provider folder for "${requestedPath}"`);
			}
			const cachedPath = matchingPaths[0] ?? requestedPath;
			const cached = this.cache.getFile(cachedPath);
			if (cached && this.cache.isFolder(cachedPath)) {
				parentUid = cached.uid;
			} else if (cached) {
				throw new Error(`Cannot create directory "${path}": "${cachedPath}" is a file`);
			} else {
				const folder = await this.client.createFolder(parentUid, part);
				if (!this.cache.applyFileChange(folder)) {
					this.cache.setFile(requestedPath, folder, "requested_echo");
				}
				parentUid = folder.uid;
			}
			const resolved = this.cache.getPathById(parentUid);
			if (!resolved) throw new Error(`Cannot resolve provider folder for "${requestedPath}"`);
			currentPath = resolved;
		}
		return parentUid;
	}
}
