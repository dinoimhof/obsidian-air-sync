import type { ProtonDriveNode } from "./drive-client";

export { spyRequestUrl, mockRes, createMockSecretStore } from "../googledrive/test-helpers.test";

/** Access private fields on ProtonDriveFs (inherited from CachingRemoteFs) in tests. */
export interface ProtonDriveFsInternal {
	/** Skip the initial full scan. */
	initialized: boolean;
	/** The in-memory event cursor (CachingRemoteFs._changesPageToken). */
	_changesPageToken: string | null;
}

/** Build a Proton Drive file node for tests. */
export function pdFile(uid: string, name: string, parentUid: string, overrides: Partial<ProtonDriveNode> = {}): ProtonDriveNode {
	return {
		uid,
		name,
		parentUid,
		isFolder: false,
		isTrashed: false,
		size: 10,
		mtime: Date.parse("2024-01-01T00:00:00Z"),
		revisionUid: `rev-${uid}`,
		treeEventScopeId: "scope-1",
		...overrides,
	};
}

/** Build a Proton Drive folder node for tests. */
export function pdFolder(uid: string, name: string, parentUid: string, overrides: Partial<ProtonDriveNode> = {}): ProtonDriveNode {
	return {
		uid,
		name,
		parentUid,
		isFolder: true,
		isTrashed: false,
		size: 0,
		mtime: 0,
		treeEventScopeId: "scope-1",
		...overrides,
	};
}
