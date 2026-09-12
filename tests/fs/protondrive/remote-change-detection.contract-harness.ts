import { vi } from "vitest";
import type { ProtonDriveClient, ProtonDriveNode } from "../../../src/fs/protondrive/drive-client";
import type { ProtonDriveFsInternal } from "../../../src/fs/protondrive/test-helpers";
import { pdFile } from "../../../src/fs/protondrive/test-helpers";
import { bytes, runRemoteChangeDetectionContract, statOrThrow } from "../contracts/remote-change-detection.contract";

const ROOT_UID = "root";

/**
 * ProtonDriveFs returns hash:"" from stat() and relies on remoteChecksum (the
 * active revision uid — a fresh value on every content change) for change
 * detection, since content is end-to-end encrypted and there is no
 * locally-reproducible plaintext hash (see docs/protondrive-backend.md).
 * checksumBased: the metadata-only touch case (mtime bumped, identical
 * revision) makes the checksum plumbing load-bearing — mtime+size alone
 * cannot decide it.
 */
export function registerProtonDriveChangeDetectionContract(): void {
	runRemoteChangeDetectionContract(
		"ProtonDriveFs",
		async () => {
			let current: ProtonDriveNode = pdFile("f1", "note.md", ROOT_UID, { revisionUid: "rev-1", size: 11 });

			const client = {
				upload: vi.fn(() => Promise.resolve(current)),
				uploadRevision: vi.fn(() => Promise.resolve(current)),
			} as unknown as ProtonDriveClient;

			const { ProtonDriveFs } = await import("../../../src/fs/protondrive");
			const fs = new ProtonDriveFs(client, ROOT_UID);
			(fs as unknown as ProtonDriveFsInternal).initialized = true;

			const path = "note.md";

			return {
				async observeWritten() {
					await fs.write(path, bytes("version one"), Date.now());
					return statOrThrow(fs, path);
				},
				async observeUnchanged() {
					return statOrThrow(fs, path);
				},
				async observeAfterEdit() {
					// A real content edit: new revision uid + bumped mtime + new size.
					current = pdFile("f1", "note.md", ROOT_UID, { revisionUid: "rev-2", size: 12 });
					await fs.write(path, bytes("version two!"), Date.now());
					return statOrThrow(fs, path);
				},
				async observeTouchedSameContent() {
					// Metadata-only touch: mtime bumped, revision uid + size identical. Only
					// the checksum comparison can prove this is "unchanged".
					current = pdFile("f1", "note.md", ROOT_UID, { revisionUid: "rev-1", size: 11, mtime: Date.now() });
					await fs.write(path, bytes("version one"), Date.now());
					return statOrThrow(fs, path);
				},
			};
		},
		{ checksumBased: true },
	);
}
