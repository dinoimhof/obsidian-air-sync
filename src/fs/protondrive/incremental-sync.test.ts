import { describe, it, expect } from "vitest";
import { ProtonDriveMetadataCache } from "./metadata-cache";
import { applyProtonDriveEvents } from "./incremental-sync";
import type { ProtonDriveClient, ProtonDriveEvent, ProtonDriveNode } from "./drive-client";
import { pdFile, pdFolder } from "./test-helpers";

const ROOT = "root";

/** Split changedPaths into modified (still cached) vs deleted (gone) — mirrors CachingRemoteFs. */
function classify(cache: ProtonDriveMetadataCache, changedPaths: Set<string>) {
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const path of changedPaths) (cache.hasFile(path) ? modified : deleted).push(path);
	return { modified, deleted };
}

/** A ProtonDriveClient stub: a fixed event stream plus a node lookup table. */
function fakeClient(events: ProtonDriveEvent[], nodes: ProtonDriveNode[] = []): ProtonDriveClient {
	const byUid = new Map(nodes.map((n) => [n.uid, n]));
	return {
		// eslint-disable-next-line @typescript-eslint/require-await -- the generator's body has no await between yields
		fetchEvents: async function* () { yield* events; },
		getItem: (uid: string) => Promise.resolve(byUid.get(uid) ?? null),
		advanceCursor: (_cursor: string, eventId: string) => eventId,
	} as unknown as ProtonDriveClient;
}

function seededCache() {
	const cache = new ProtonDriveMetadataCache(ROOT);
	cache.buildFromFiles([
		pdFile("f1", "a.md", ROOT),
		pdFolder("d1", "dir", ROOT),
		pdFile("f2", "b.md", "d1"),
	]);
	return cache;
}

function ctx(cache: ProtonDriveMetadataCache, client: ProtonDriveClient) {
	return { cache, client, rootId: ROOT };
}

function created(nodeUid: string, eventId: string): ProtonDriveEvent {
	return { type: "node_created", nodeUid, eventId };
}
function updated(nodeUid: string, eventId: string): ProtonDriveEvent {
	return { type: "node_updated", nodeUid, eventId };
}
function deletedEvent(nodeUid: string, eventId: string): ProtonDriveEvent {
	return { type: "node_deleted", nodeUid, eventId };
}

describe("applyProtonDriveEvents", () => {
	it("upserts a newly created node and returns the advanced cursor", async () => {
		const cache = seededCache();
		const client = fakeClient([created("f3", "e2")], [pdFile("f3", "c.md", ROOT)]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(result.newToken).toBe("e2");
		expect(cache.hasFile("c.md")).toBe(true);
		expect(classify(cache, result.changedPaths).modified).toContain("c.md");
	});

	it("removes a deleted subtree on a node_deleted event", async () => {
		const cache = seededCache();
		const client = fakeClient([deletedEvent("d1", "e2")]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		const delta = classify(cache, result.changedPaths);
		expect(delta.deleted).toEqual(expect.arrayContaining(["dir", "dir/b.md"]));
	});

	it("treats a create/update racing an immediate delete (node now gone) as a tombstone", async () => {
		const cache = seededCache();
		const client = fakeClient([updated("f1", "e2")], []); // getItem("f1") resolves to null
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("a.md")).toBe(false);
	});

	it("coalesces a same-uid rename into a renamedPair", async () => {
		const cache = seededCache();
		const client = fakeClient([updated("f1", "e2")], [pdFile("f1", "renamed.md", ROOT)]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("renamed.md")).toBe(true);
		expect(cache.hasFile("a.md")).toBe(false);
		expect(result.renamedPaths).toEqual([{ oldPath: "a.md", newPath: "renamed.md", isFolder: undefined }]);
	});

	it("rewrites child paths when a folder is renamed via the same uid", async () => {
		const cache = seededCache();
		const client = fakeClient([updated("d1", "e2")], [pdFolder("d1", "papers", ROOT)]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(result.renamedPaths).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
	});

	it("reports a tracked node moved outside the root as deleted", async () => {
		const cache = seededCache();
		const client = fakeClient([updated("f1", "e2")], [pdFile("f1", "a.md", "unknown-parent")]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(cache.hasFile("a.md")).toBe(false);
		expect(classify(cache, result.changedPaths).deleted).toContain("a.md");
	});

	it("ignores fast_forward events but still advances the cursor", async () => {
		const cache = seededCache();
		const client = fakeClient([{ type: "fast_forward", eventId: "e2" }]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		if (result.needsFullScan) throw new Error("unexpected resync");

		expect(result.newToken).toBe("e2");
		expect(result.changedPaths.size).toBe(0);
	});

	it("signals needsFullScan on a tree_refresh event", async () => {
		const cache = seededCache();
		const client = fakeClient([{ type: "tree_refresh", eventId: "e2" }]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		expect(result.needsFullScan).toBe(true);
	});

	it("signals needsFullScan on a tree_remove event", async () => {
		const cache = seededCache();
		const client = fakeClient([{ type: "tree_remove", eventId: "none" }]);
		const result = await applyProtonDriveEvents(ctx(cache, client), "e1");
		expect(result.needsFullScan).toBe(true);
	});
});
