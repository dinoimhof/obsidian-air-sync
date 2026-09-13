// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import { describe, it, expect } from "vitest";
import { protonDriveGetNode, protonDriveGetRootFolder, type ProtonDriveClientHandle } from "./protondrive";

function fakeHandle(methods: Record<string, (...args: never[]) => unknown>): ProtonDriveClientHandle {
	return methods;
}

function rawNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		uid: "node-1",
		parentUid: "parent-1",
		name: { ok: true, value: "Test.md" },
		type: "file",
		treeEventScopeId: "scope-1",
		modificationTime: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

describe("protonDriveGetNode — size projection", () => {
	it("uses activeRevision.claimedSize (the plaintext size), never storageSize (the ciphertext size)", async () => {
		const handle = fakeHandle({
			getNode: () => Promise.resolve(rawNode({
				activeRevision: { uid: "rev-1", storageSize: 9999, claimedSize: 42 },
			})),
		});

		const node = await protonDriveGetNode(handle, "node-1");

		// A real Drive revision's storageSize (encrypted-on-server size) is always larger
		// than the plaintext size due to encryption overhead — reporting it as `size` would
		// make sync's post-write terminal-size proof fail on every non-empty file (see
		// docs/protondrive-backend.md's "every upload/verify" bug writeup).
		expect(node.size).toBe(42);
		expect(node.size).not.toBe(9999);
	});

	it("falls back to storageSize only when claimedSize is unavailable", async () => {
		const handle = fakeHandle({
			getNode: () => Promise.resolve(rawNode({
				activeRevision: { uid: "rev-1", storageSize: 9999 },
			})),
		});

		const node = await protonDriveGetNode(handle, "node-1");

		expect(node.size).toBe(9999);
	});

	it("reports size 0 for a folder (no activeRevision at all)", async () => {
		const handle = fakeHandle({
			getNode: () => Promise.resolve(rawNode({ type: "folder", activeRevision: undefined })),
		});

		const node = await protonDriveGetNode(handle, "node-1");

		expect(node.isFolder).toBe(true);
		expect(node.size).toBe(0);
	});

	it("reports size 0 for an empty file with no revision size fields", async () => {
		const handle = fakeHandle({
			getNode: () => Promise.resolve(rawNode({ activeRevision: { uid: "rev-1" } })),
		});

		const node = await protonDriveGetNode(handle, "node-1");

		expect(node.size).toBe(0);
	});
});

describe("protonDriveGetRootFolder", () => {
	it("projects the root folder node with size 0", async () => {
		const handle = fakeHandle({
			getMyFilesRootFolder: () => Promise.resolve(rawNode({ uid: "root", type: "folder", activeRevision: undefined })),
		});

		const node = await protonDriveGetRootFolder(handle);

		expect(node.uid).toBe("root");
		expect(node.isFolder).toBe(true);
		expect(node.size).toBe(0);
	});
});
