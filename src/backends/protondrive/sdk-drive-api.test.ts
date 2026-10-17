import { describe, expect, it } from "vitest";
import type { DriveEvent, ProtonDriveClient } from "@protontech/drive-sdk";
import { DriveEventType } from "@protontech/drive-sdk";
import { SdkDriveApi } from "./sdk-drive-api";
import type { NodeEntity } from "@protontech/drive-sdk";
import { NodeType } from "@protontech/drive-sdk";
import type { EventId, NodeUid, RevisionUid, TreeScopeId } from "./drive-api";
import { toDriveNode } from "./sdk-drive-api";

function apiWithEvents(events: readonly unknown[]): SdkDriveApi {
	const client = {
		iterateEvents: async function* () {
			for (const event of events) yield event as DriveEvent;
			await Promise.resolve();
		},
	} as unknown as ProtonDriveClient;
	return new SdkDriveApi(client);
}

const node = (type: DriveEventType, nodeUid: string, eventId: string) => ({ type, nodeUid, eventId, treeEventScopeId: "vol" });
const read = (events: readonly unknown[]) => apiWithEvents(events).readEvents("vol" as TreeScopeId, "e0" as EventId);

describe("SdkDriveApi.readEvents: the events feed", () => {
	it("collects touched nodes once and advances to the last event", async () => {
		await expect(read([
			node(DriveEventType.NodeCreated, "vol~a", "e1"),
			node(DriveEventType.NodeUpdated, "vol~a", "e2"),
			node(DriveEventType.NodeDeleted, "vol~b", "e3"),
		])).resolves.toEqual({ kind: "events", touched: ["vol~a", "vol~b"], lastEventId: "e3" });
	});

	it("advances past fast-forward and shared-with-me events without touching nodes", async () => {
		await expect(read([
			{ type: DriveEventType.FastForward, treeEventScopeId: "vol", eventId: "e4" },
			{ type: DriveEventType.SharedWithMeUpdated, eventId: "e5", treeEventScopeId: "core" },
		])).resolves.toEqual({ kind: "events", touched: [], lastEventId: "e5" });
	});

	it("asks for a rescan on a tree refresh", async () => {
		await expect(read([{ type: DriveEventType.TreeRefresh, treeEventScopeId: "vol", eventId: "e6" }])).resolves.toEqual({ kind: "refresh" });
	});

	it("asks for a rescan on an event type it does not know, instead of skipping it", async () => {
		await expect(read([
			node(DriveEventType.NodeCreated, "vol~a", "e1"),
			{ type: "node_moved_v2", nodeUid: "vol~c", treeEventScopeId: "vol", eventId: "e7" },
		])).resolves.toEqual({ kind: "refresh" });
	});

	it("fails when the volume is no longer accessible", async () => {
		await expect(read([{ type: DriveEventType.TreeRemove, treeEventScopeId: "vol", eventId: "e8" }])).rejects.toMatchObject({ kind: "not_found" });
	});
});

// ---- SDK boundary: node projection, reads, transfers and mutations over a faked client ----


function entity(overrides: Partial<NodeEntity> & { uid: string }): NodeEntity {
	return {
		parentUid: "vol~parent",
		name: { ok: true, value: "note.md" },
		type: NodeType.File,
		mediaType: "text/markdown",
		treeEventScopeId: "vol",
		...overrides,
	} as unknown as NodeEntity;
}

const revision = {
	uid: "vol~n~r1",
	storageSize: 999,
	claimedSize: 5,
	claimedModificationTime: new Date(1234),
	claimedDigests: { sha1: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", sha1Verified: true },
};

describe("toDriveNode (the SDK parse boundary)", () => {
	it("projects the plaintext claimed size, never the encrypted storage size, and a lowercase SHA-1", () => {
		const node = toDriveNode(entity({ uid: "vol~n", activeRevision: revision as never }));
		expect(node.revision).toEqual({ uid: "vol~n~r1", size: 5, mtimeMs: 1234, sha1: "abcdef0123456789abcdef0123456789abcdef01" });
		expect(node).toMatchObject({ kind: "file", trashed: false, degraded: false, name: "note.md" });
	});

	it("maps an undecryptable name to null, decryption errors to degraded, trash and node types", () => {
		expect(toDriveNode(entity({ uid: "a", name: { ok: false, error: new Error("x") } as never })).name).toBeNull();
		expect(toDriveNode(entity({ uid: "b", errors: [new Error("node key")] })).degraded).toBe(true);
		expect(toDriveNode(entity({ uid: "c", trashTime: new Date() })).trashed).toBe(true);
		expect(toDriveNode(entity({ uid: "d", type: NodeType.Folder })).kind).toBe("folder");
		expect(toDriveNode(entity({ uid: "e", type: "album" as never })).kind).toBe("other");
	});
});

type Recorded = Array<[string, ...unknown[]]>;

function fakeClient(options: { nodes?: NodeEntity[]; children?: string[]; events?: unknown[]; download?: "ok" | "bad-signature" | "fail"; fail?: Error } = {}) {
	const calls: Recorded = [];
	const results = (ok: boolean) => (async function* () {
		await Promise.resolve();
		yield ok ? { uid: "x", ok: true } : { uid: "x", ok: false, error: new Error("refused") };
	})();
	const client = {
		getMyFilesRootFolder: () => Promise.resolve(entity({ uid: "vol~root", type: NodeType.Folder, parentUid: undefined })),
		iterateNodes: async function* (uids: string[]) {
			await Promise.resolve();
			for (const uid of uids) {
				const found = options.nodes?.find((node) => node.uid === uid);
				yield found ?? { missingUid: uid };
			}
		},
		iterateFolderChildrenNodeUids: async function* () {
			await Promise.resolve();
			for (const uid of options.children ?? []) yield uid;
		},
		iterateEvents: async function* () {
			await Promise.resolve();
			for (const event of options.events ?? []) yield event;
		},
		getFileRevisionDownloader: () => {
			if (options.fail) return Promise.reject(options.fail);
			return Promise.resolve({
				downloadToStream: (sink: WritableStream<Uint8Array>) => {
					const done = (async () => {
						const writer = sink.getWriter();
						await writer.write(new Uint8Array([104, 105]));
						await writer.write(new Uint8Array([33]));
						await writer.close();
						if (options.download !== "ok" && options.download !== undefined) throw new Error("signature");
					})();
					return { completion: () => done, isDownloadCompleteWithSignatureIssues: () => options.download === "bad-signature" };
				},
			});
		},
		getFileUploader: (parent: string, name: string, metadata: unknown) => {
			calls.push(["upload", parent, name, metadata]);
			return Promise.resolve({ uploadFromStream: () => Promise.resolve({ completion: () => Promise.resolve({ nodeUid: "vol~new" }) }) });
		},
		getFileRevisionUploader: (file: string, metadata: unknown) => {
			calls.push(["revision", file, metadata]);
			return Promise.resolve({ uploadFromStream: () => Promise.resolve({ completion: () => Promise.resolve({}) }) });
		},
		createFolder: (parent: string, name: string) => {
			calls.push(["mkdir", parent, name]);
			return Promise.resolve(entity({ uid: "vol~dir", type: NodeType.Folder, parentUid: parent, name: { ok: true, value: name } as never }));
		},
		renameNode: (uid: string, name: string) => {
			calls.push(["rename", uid, name]);
			return options.fail ? Promise.reject(options.fail) : Promise.resolve();
		},
		moveNodes: (uids: string[], parent: string) => {
			calls.push(["move", uids, parent]);
			return results(true);
		},
		trashNodes: (uids: string[]) => {
			calls.push(["trash", uids]);
			return results(false);
		},
	};
	return { api: new SdkDriveApi(client as unknown as ProtonDriveClient), calls };
}

describe("SdkDriveApi reads", () => {
	it("returns only nodes that exist and lists only live children", async () => {
		const live = entity({ uid: "vol~a" });
		const trashed = entity({ uid: "vol~b", trashTime: new Date() });
		const { api } = fakeClient({ nodes: [live, trashed], children: ["vol~a", "vol~b", "vol~gone"] });
		expect([...(await api.getNodes(["vol~a", "vol~gone"] as NodeUid[])).keys()]).toEqual(["vol~a"]);
		expect((await api.getNodes([])).size).toBe(0);
		expect((await api.listChildren("vol~root" as NodeUid)).map((node) => node.uid)).toEqual(["vol~a"]);
		expect((await api.getMyFilesRoot()).uid).toBe("vol~root");
	});

	it("reads the latest event id from the fast-forward event, and fails without one", async () => {
		const withId = fakeClient({ events: [{ type: DriveEventType.FastForward, eventId: "e9", treeEventScopeId: "vol" }] });
		await expect(withId.api.latestEventId("vol" as TreeScopeId)).resolves.toBe("e9");
		await expect(fakeClient().api.latestEventId("vol" as TreeScopeId)).rejects.toMatchObject({ kind: "transient" });
	});

	it("assembles a download, and reports bad signatures and failures distinctly", async () => {
		const ok = await fakeClient({ download: "ok" }).api.downloadRevision("vol~n~r1" as RevisionUid);
		expect(ok.kind === "content" && new TextDecoder().decode(ok.bytes)).toBe("hi!");
		await expect(fakeClient({ download: "bad-signature" }).api.downloadRevision("r" as RevisionUid)).resolves.toEqual({ kind: "signature_invalid" });
		await expect(fakeClient({ download: "fail" }).api.downloadRevision("r" as RevisionUid)).rejects.toMatchObject({ kind: "transient" });
		const notFound = Object.assign(new Error("gone"), { name: "NotFoundAPIError" });
		await expect(fakeClient({ fail: notFound }).api.downloadRevision("r" as RevisionUid)).rejects.toMatchObject({ kind: "not_found" });
	});
});

describe("SdkDriveApi transfers and mutations", () => {
	const metadata = { mediaType: "text/markdown", sha1: "aa", mtimeMs: 5000 };

	it("uploads with the expected size, SHA-1 and modification time", async () => {
		const { api, calls } = fakeClient();
		await expect(api.createFile("vol~p" as NodeUid, "n.md", new ArrayBuffer(3), metadata)).resolves.toBe("vol~new");
		await api.uploadRevision("vol~n" as NodeUid, new ArrayBuffer(4), metadata);
		expect(calls[0]).toEqual(["upload", "vol~p", "n.md", { mediaType: "text/markdown", expectedSize: 3, expectedSha1: "aa", modificationTime: new Date(5000) }]);
		expect(calls[1]).toEqual(["revision", "vol~n", { mediaType: "text/markdown", expectedSize: 4, expectedSha1: "aa", modificationTime: new Date(5000) }]);
	});

	it("creates folders, renames, moves, and surfaces a refused trash as an error", async () => {
		const { api, calls } = fakeClient();
		expect((await api.createFolder("vol~p" as NodeUid, "dir")).kind).toBe("folder");
		await api.rename("vol~n" as NodeUid, "m.md");
		await api.move("vol~n" as NodeUid, "vol~q" as NodeUid);
		await expect(api.trash("vol~n" as NodeUid)).rejects.toMatchObject({ kind: "transient" });
		expect(calls.map(([op]) => op)).toEqual(["mkdir", "rename", "move", "trash"]);
	});

	it("translates a same-name clash into target_changed", async () => {
		const clash = Object.assign(new Error("exists"), { name: "NodeWithSameNameExistsValidationError" });
		await expect(fakeClient({ fail: clash }).api.rename("vol~n" as NodeUid, "m.md")).rejects.toMatchObject({ kind: "target_changed" });
	});
});
