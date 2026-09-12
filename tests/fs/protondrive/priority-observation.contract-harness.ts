import { describe, expect, it, vi } from "vitest";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";
import { ProtonDriveFs } from "../../../src/fs/protondrive";
import type { ProtonDriveClient, ProtonDriveNode } from "../../../src/fs/protondrive/drive-client";

const CONTENT = new Uint8Array([1, 2, 3]).buffer;
const ROOT_UID = "root";

interface ProtonDrivePriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

function node(overrides: Partial<ProtonDriveNode> = {}): ProtonDriveNode {
	return {
		uid: "file-1", parentUid: ROOT_UID, name: "note.md", isFolder: false, isTrashed: false,
		size: 3, mtime: Date.parse("2026-08-27T00:00:00Z"), revisionUid: "rev-2", treeEventScopeId: "scope-1",
		...overrides,
	};
}

function makeProtonDriveHarness(scenario: PriorityObservationScenario): ProtonDrivePriorityHarness {
	let current = node();
	const replacement = node({ uid: "file-2", revisionUid: "rev-3" });
	if (scenario === "unverifiable") current = node({ revisionUid: undefined });

	const getItem = vi.fn(() => {
		if (scenario === "missing" || scenario === "replacement") return Promise.resolve(null);
		return Promise.resolve(current);
	});
	const getChildByName = vi.fn(() => {
		if (scenario === "missing") return Promise.resolve(null);
		if (scenario === "replacement") return Promise.resolve(replacement);
		return Promise.resolve(current);
	});
	const download = vi.fn(() => {
		if (scenario === "changed-during-read") current = node({ revisionUid: "rev-99" });
		return Promise.resolve(CONTENT);
	});
	const fs = new ProtonDriveFs(
		{ getItem, getChildByName, download } as unknown as ProtonDriveClient,
		ROOT_UID,
	);
	return {
		fs,
		request: { path: "note.md", identityKey: "file-1" },
		expectedToken: "protondrive:rev-2",
		expectedContent: CONTENT,
		replacementIdentityKey: "file-2",
		assertIdentityReadRoute: () => {
			expect(getChildByName).toHaveBeenCalledWith(ROOT_UID, "note.md");
			expect(download).toHaveBeenCalledWith("file-1");
		},
	};
}

export function registerProtonDrivePriorityObservationContract(): void {
	runPriorityObservationContract("ProtonDriveFs", makeProtonDriveHarness);
	describe("ProtonDriveFs priority observation addressing", () => {
		it("resolves the path occupant and downloads by the admitted stable identity", async () => {
			const harness = makeProtonDriveHarness("current");
			try {
				const observed = await harness.fs.priority.observe(harness.request);
				if (observed.kind !== "current") throw new Error("expected current observation");
				await harness.fs.priority.read(observed);
				harness.assertIdentityReadRoute();
			} finally {
				await harness.fs.close?.();
			}
		});
	});
}
