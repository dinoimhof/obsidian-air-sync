// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import {
	isProtonDriveNotFoundError,
	protonDriveCreateFolder,
	protonDriveDownloadFile,
	protonDriveExistingNodeUid,
	protonDriveGetAvailableName,
	protonDriveGetNode,
	protonDriveGetRootFolder,
	protonDriveGetStartEventId,
	protonDriveIterateEvents,
	protonDriveIterateFolderChildren,
	protonDriveMoveNode,
	protonDriveRenameNode,
	protonDriveTrashNodes,
	protonDriveUploadFile,
	protonDriveUploadRevision,
	type ProtonDriveClientHandle,
	type ProtonDriveEvent,
	type ProtonDriveNode,
} from "../../platform/protondrive";

export type { ProtonDriveNode, ProtonDriveEvent };

/** Hard cap on drained children per folder (a runaway generator would otherwise loop forever). */
const LIST_PAGE_CAP = 100_000;

interface ProtonCursor {
	scopeId: string;
	eventId: string;
}

function encodeCursor(scopeId: string, eventId: string): string {
	return JSON.stringify({ scopeId, eventId });
}

function decodeCursor(cursor: string): ProtonCursor {
	try {
		const parsed: unknown = JSON.parse(cursor);
		if (typeof parsed === "object" && parsed !== null) {
			const rec = parsed as Record<string, unknown>;
			if (typeof rec.scopeId === "string" && typeof rec.eventId === "string") {
				return { scopeId: rec.scopeId, eventId: rec.eventId };
			}
		}
	} catch {
		// fall through to the thrown error below
	}
	throw new Error("Proton Drive: malformed sync cursor");
}

/**
 * Wraps `@protontech/drive-sdk`'s node operations (via `platform/protondrive.ts`)
 * behind a small, backend-specific interface — mirroring `OneDriveClient`'s role
 * relative to Microsoft Graph. `ProtonDriveFs`/`ProtonDriveMetadataCache` only ever
 * see this class and `ProtonDriveNode`, never the raw SDK.
 *
 * Nodes are addressed by opaque `uid`, single-parent (`parentUid`) — like OneDrive's
 * `id`/`parentReference.id`, unlike Google Drive's multi-parent model. The SDK has
 * no path-relative lookup or flat recursive listing, so `getChildByName`/`fullList`
 * are built here from per-folder child iteration.
 */
export class ProtonDriveClient {
	constructor(private readonly handle: ProtonDriveClientHandle) {}

	/** A single node's current metadata, or `null` if deleted/trashed/gone. */
	async getItem(nodeUid: string): Promise<ProtonDriveNode | null> {
		try {
			const node = await protonDriveGetNode(this.handle, nodeUid);
			return node.isTrashed ? null : node;
		} catch (err) {
			if (isProtonDriveNotFoundError(err)) return null;
			throw err;
		}
	}

	async listChildren(parentUid: string): Promise<ProtonDriveNode[]> {
		const nodes: ProtonDriveNode[] = [];
		for await (const node of protonDriveIterateFolderChildren(this.handle, parentUid)) {
			if (!node.isTrashed) nodes.push(node);
		}
		return nodes;
	}

	async getChildByName(parentUid: string, name: string): Promise<ProtonDriveNode | null> {
		const children = await this.listChildren(parentUid);
		return children.find((child) => child.name === name) ?? null;
	}

	/** The root of the account's "My files" section — the anchor for `resolveRemoteVault`/the folder browser. */
	getRootFolder(): Promise<ProtonDriveNode> {
		return protonDriveGetRootFolder(this.handle);
	}

	/**
	 * Recursively enumerate every node under `rootUid`. The SDK has no flat
	 * recursive-listing or full-delta call (unlike Graph's `/delta` or Google
	 * Drive's `files.list`), so this walks the tree one folder at a time —
	 * documented as a known scaling limitation for very large vaults (see
	 * docs/protondrive-backend.md).
	 */
	async fullList(rootUid: string): Promise<ProtonDriveNode[]> {
		const result: ProtonDriveNode[] = [];
		const queue = [rootUid];
		for (let guard = 0; queue.length > 0; guard++) {
			if (guard >= LIST_PAGE_CAP) {
				throw new Error(`fullList: exceeded ${LIST_PAGE_CAP} folders (unexpectedly large or cyclic tree?)`);
			}
			const parentUid = queue.shift()!;
			const children = await this.listChildren(parentUid);
			for (const child of children) {
				result.push(child);
				if (child.isFolder) queue.push(child.uid);
			}
		}
		return result;
	}

	/** Capture a cursor covering events from *now* onward (no history to replay). */
	async getStartCursor(rootUid: string): Promise<string> {
		const root = await protonDriveGetNode(this.handle, rootUid);
		const eventId = await protonDriveGetStartEventId(this.handle, root.treeEventScopeId);
		return encodeCursor(root.treeEventScopeId, eventId);
	}

	async *fetchEvents(cursor: string): AsyncGenerator<ProtonDriveEvent> {
		const { scopeId, eventId } = decodeCursor(cursor);
		yield* protonDriveIterateEvents(this.handle, scopeId, eventId);
	}

	/** Advance a cursor to a newly observed event id, keeping the same scope. */
	advanceCursor(cursor: string, eventId: string): string {
		return encodeCursor(decodeCursor(cursor).scopeId, eventId);
	}

	/** Idempotent: a name conflict resolves to the existing child, like `OneDriveClient.createFolder`. */
	async createFolder(parentUid: string, name: string): Promise<ProtonDriveNode> {
		try {
			return await protonDriveCreateFolder(this.handle, parentUid, name);
		} catch (err) {
			const existingUid = protonDriveExistingNodeUid(err);
			if (existingUid) {
				const existing = await protonDriveGetNode(this.handle, existingUid);
				// The conflicting node could be a FILE with the same name — the SDK's
				// conflict error doesn't say which. Silently returning it as "the folder"
				// would corrupt find-or-create (e.g. resolveRemoteVault binding to a file).
				if (!existing.isFolder) throw new Error(`Proton Drive: "${name}" already exists as a file, not a folder`);
				return existing;
			}
			throw err;
		}
	}

	/** Create a brand-new file (rejects if `name` already exists under `parentUid`). */
	async upload(parentUid: string, name: string, content: ArrayBuffer, mtime: number): Promise<ProtonDriveNode> {
		const { nodeUid } = await protonDriveUploadFile(this.handle, parentUid, name, content, mtime);
		return protonDriveGetNode(this.handle, nodeUid);
	}

	/** Overwrite an existing file with a new revision. */
	async uploadRevision(nodeUid: string, content: ArrayBuffer, mtime: number): Promise<ProtonDriveNode> {
		await protonDriveUploadRevision(this.handle, nodeUid, content, mtime);
		return protonDriveGetNode(this.handle, nodeUid);
	}

	download(nodeUid: string): Promise<ArrayBuffer> {
		return protonDriveDownloadFile(this.handle, nodeUid);
	}

	/** Rename and/or reparent (two SDK calls — not atomic; see docs/protondrive-backend.md). */
	async move(nodeUid: string, newName: string | undefined, newParentUid: string | undefined): Promise<ProtonDriveNode> {
		if (newParentUid !== undefined) await protonDriveMoveNode(this.handle, nodeUid, newParentUid);
		if (newName !== undefined) await protonDriveRenameNode(this.handle, nodeUid, newName);
		return protonDriveGetNode(this.handle, nodeUid);
	}

	/** Idempotent: an already-gone item is a no-op success, like `OneDriveClient.deleteItem`. */
	async deleteItem(nodeUid: string): Promise<void> {
		try {
			await protonDriveTrashNodes(this.handle, [nodeUid]);
		} catch (err) {
			if (isProtonDriveNotFoundError(err)) return;
			throw err;
		}
	}

	getAvailableName(parentUid: string, name: string): Promise<string> {
		return protonDriveGetAvailableName(this.handle, parentUid, name);
	}
}
