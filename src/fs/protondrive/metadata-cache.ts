// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { FileEntity } from "../types";
import type { ProtonDriveNode } from "./drive-client";
import { AbstractMetadataCache } from "../caching/metadata-cache";

/** Project a cached `ProtonDriveNode` into a `FileEntity` (shared by `toEntity` and `toDetachedEntity`). */
export function protonDriveNodeToEntity(path: string, node: ProtonDriveNode): Omit<FileEntity, "pathAuthority"> {
	return {
		path,
		identityKey: node.uid,
		isDirectory: node.isFolder,
		size: node.isFolder ? 0 : node.size,
		mtime: node.mtime,
		hash: "",
		remoteChecksum: !node.isFolder && node.revisionUid ? { algo: "opaque", value: node.revisionUid } : undefined,
		backendMeta: { protonDriveUid: node.uid, revisionUid: node.revisionUid },
	};
}

/**
 * Proton Drive's metadata cache. All the data structures and path/tree logic live
 * in {@link AbstractMetadataCache}; this subclass only reads the SDK's `NodeEntity`
 * shape (as projected by `platform/protondrive.ts` into `ProtonDriveNode`) — a
 * single `parentUid`, exactly like OneDrive's `parentReference.id` — and projects
 * a `FileEntity` carrying the "opaque" content checksum (the active revision's
 * uid: a fresh value on every content change, since content is end-to-end
 * encrypted and there is no locally-reproducible plaintext hash to expose).
 */
export class ProtonDriveMetadataCache extends AbstractMetadataCache<ProtonDriveNode> {
	protected extractId(node: ProtonDriveNode): string {
		return node.uid;
	}

	protected extractParentIds(node: ProtonDriveNode): string[] {
		return node.parentUid ? [node.parentUid] : [];
	}

	protected extractName(node: ProtonDriveNode): string {
		return node.name;
	}

	protected isFolderEntry(node: ProtonDriveNode): boolean {
		return node.isFolder;
	}

	/** Build a FileEntity from cached node metadata (no download). hash stays "". */
	toEntity(path: string, node: ProtonDriveNode): FileEntity {
		return { ...protonDriveNodeToEntity(path, node), pathAuthority: this.getPathAuthority(path) };
	}
}
