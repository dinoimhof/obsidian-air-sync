import { describe, it, expect, vi, afterEach } from "vitest";
import { pdFile, pdFolder } from "./test-helpers";

const protonDriveGetNode = vi.fn();
const protonDriveGetRootFolder = vi.fn();
const protonDriveIterateFolderChildren = vi.fn();
const protonDriveCreateFolder = vi.fn();
const protonDriveRenameNode = vi.fn();
const protonDriveMoveNode = vi.fn();
const protonDriveTrashNodes = vi.fn();
const protonDriveGetAvailableName = vi.fn();
const protonDriveUploadFile = vi.fn();
const protonDriveUploadRevision = vi.fn();
const protonDriveDownloadFile = vi.fn();
const protonDriveIterateEvents = vi.fn();
const protonDriveGetStartEventId = vi.fn();
const isProtonDriveNotFoundError = vi.fn();
const protonDriveExistingNodeUid = vi.fn();

vi.mock("../../platform/protondrive", () => ({
	protonDriveGetNode,
	protonDriveGetRootFolder,
	protonDriveIterateFolderChildren,
	protonDriveCreateFolder,
	protonDriveRenameNode,
	protonDriveMoveNode,
	protonDriveTrashNodes,
	protonDriveGetAvailableName,
	protonDriveUploadFile,
	protonDriveUploadRevision,
	protonDriveDownloadFile,
	protonDriveIterateEvents,
	protonDriveGetStartEventId,
	isProtonDriveNotFoundError,
	protonDriveExistingNodeUid,
}));

afterEach(() => {
	vi.clearAllMocks();
});

function asyncGenOf<T>(items: T[]) {
	return function* () {
		for (const item of items) yield item;
	};
}

describe("ProtonDriveClient.getItem", () => {
	it("returns the node when present and not trashed", async () => {
		const node = pdFile("f1", "a.md", "root");
		protonDriveGetNode.mockResolvedValue(node);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect(await client.getItem("f1")).toBe(node);
	});

	it("returns null for a trashed node", async () => {
		protonDriveGetNode.mockResolvedValue(pdFile("f1", "a.md", "root", { isTrashed: true }));
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect(await client.getItem("f1")).toBeNull();
	});

	it("returns null when the underlying error is a not-found error", async () => {
		protonDriveGetNode.mockRejectedValue(new Error("gone"));
		isProtonDriveNotFoundError.mockReturnValue(true);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect(await client.getItem("f1")).toBeNull();
	});

	it("rethrows any other error", async () => {
		protonDriveGetNode.mockRejectedValue(new Error("network blip"));
		isProtonDriveNotFoundError.mockReturnValue(false);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await expect(client.getItem("f1")).rejects.toThrow("network blip");
	});
});

describe("ProtonDriveClient.listChildren / getChildByName", () => {
	it("filters out trashed children", async () => {
		protonDriveIterateFolderChildren.mockImplementation(asyncGenOf([
			pdFile("f1", "a.md", "root"),
			pdFile("f2", "b.md", "root", { isTrashed: true }),
		]));
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const children = await client.listChildren("root");
		expect(children.map((c) => c.uid)).toEqual(["f1"]);
	});

	it("getChildByName finds a child by exact name, or null", async () => {
		protonDriveIterateFolderChildren.mockImplementation(asyncGenOf([pdFile("f1", "a.md", "root")]));
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect((await client.getChildByName("root", "a.md"))?.uid).toBe("f1");
		expect(await client.getChildByName("root", "missing.md")).toBeNull();
	});
});

describe("ProtonDriveClient.fullList", () => {
	it("recursively walks nested folders", async () => {
		protonDriveIterateFolderChildren.mockImplementation(function* (_handle: unknown, parentUid: string) {
			if (parentUid === "root") {
				yield pdFolder("d1", "dir", "root");
				yield pdFile("f1", "a.md", "root");
			} else if (parentUid === "d1") {
				yield pdFile("f2", "b.md", "d1");
			}
		});
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const all = await client.fullList("root");
		expect(all.map((n) => n.uid).sort()).toEqual(["d1", "f1", "f2"]);
	});
});

describe("ProtonDriveClient cursor lifecycle", () => {
	it("getStartCursor encodes the root's scope id and the captured start event id", async () => {
		protonDriveGetNode.mockResolvedValue(pdFolder("root", "", "", { treeEventScopeId: "scope-x" }));
		protonDriveGetStartEventId.mockResolvedValue("e0");
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const cursor = await client.getStartCursor("root");
		expect(JSON.parse(cursor)).toEqual({ scopeId: "scope-x", eventId: "e0" });
		expect(protonDriveGetStartEventId).toHaveBeenCalledWith({}, "scope-x");
	});

	it("fetchEvents decodes the cursor and forwards scopeId + eventId", async () => {
		protonDriveIterateEvents.mockImplementation(asyncGenOf([{ type: "fast_forward", eventId: "e1" }]));
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const events = [];
		for await (const event of client.fetchEvents(JSON.stringify({ scopeId: "scope-x", eventId: "e0" }))) events.push(event);
		expect(events).toEqual([{ type: "fast_forward", eventId: "e1" }]);
		expect(protonDriveIterateEvents).toHaveBeenCalledWith({}, "scope-x", "e0");
	});

	it("advanceCursor keeps the scope id and swaps in the new event id", async () => {
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const cursor = JSON.stringify({ scopeId: "scope-x", eventId: "e0" });
		expect(JSON.parse(client.advanceCursor(cursor, "e5"))).toEqual({ scopeId: "scope-x", eventId: "e5" });
	});

	it("rejects a malformed cursor", async () => {
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await expect(async () => {
			for await (const event of client.fetchEvents("not json")) void event;
		}).rejects.toThrow("malformed sync cursor");
	});
});

describe("ProtonDriveClient.createFolder", () => {
	it("returns the newly created folder on success", async () => {
		const folder = pdFolder("d1", "dir", "root");
		protonDriveCreateFolder.mockResolvedValue(folder);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect(await client.createFolder("root", "dir")).toBe(folder);
	});

	it("resolves a name-conflict error to the existing child (idempotent)", async () => {
		protonDriveCreateFolder.mockRejectedValue(new Error("conflict"));
		protonDriveExistingNodeUid.mockReturnValue("d1");
		const existing = pdFolder("d1", "dir", "root");
		protonDriveGetNode.mockResolvedValue(existing);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect(await client.createFolder("root", "dir")).toBe(existing);
	});

	it("rethrows a non-conflict error", async () => {
		protonDriveCreateFolder.mockRejectedValue(new Error("network blip"));
		protonDriveExistingNodeUid.mockReturnValue(undefined);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await expect(client.createFolder("root", "dir")).rejects.toThrow("network blip");
	});

	it("rejects a conflict that resolves to an existing FILE (not a folder)", async () => {
		protonDriveCreateFolder.mockRejectedValue(new Error("conflict"));
		protonDriveExistingNodeUid.mockReturnValue("f1");
		protonDriveGetNode.mockResolvedValue(pdFile("f1", "dir", "root"));
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await expect(client.createFolder("root", "dir")).rejects.toThrow("already exists as a file");
	});
});

describe("ProtonDriveClient.getRootFolder", () => {
	it("delegates to the platform wrapper", async () => {
		const root = pdFolder("root-uid", "", "");
		protonDriveGetRootFolder.mockResolvedValue(root);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		expect(await client.getRootFolder()).toBe(root);
	});
});

describe("ProtonDriveClient.upload / uploadRevision", () => {
	it("upload creates a new file then re-fetches its full metadata", async () => {
		protonDriveUploadFile.mockResolvedValue({ nodeUid: "f1", revisionUid: "rev-1" });
		const node = pdFile("f1", "a.md", "root");
		protonDriveGetNode.mockResolvedValue(node);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const content = new TextEncoder().encode("hi").buffer;
		expect(await client.upload("root", "a.md", content, 1000)).toBe(node);
		expect(protonDriveUploadFile).toHaveBeenCalledWith({}, "root", "a.md", content, 1000);
	});

	it("uploadRevision overwrites an existing file then re-fetches its metadata", async () => {
		protonDriveUploadRevision.mockResolvedValue({ nodeUid: "f1", revisionUid: "rev-2" });
		const node = pdFile("f1", "a.md", "root", { revisionUid: "rev-2" });
		protonDriveGetNode.mockResolvedValue(node);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		const content = new TextEncoder().encode("hi again").buffer;
		expect(await client.uploadRevision("f1", content, 2000)).toBe(node);
		expect(protonDriveUploadRevision).toHaveBeenCalledWith({}, "f1", content, 2000);
	});
});

describe("ProtonDriveClient.move", () => {
	it("calls only the reparent op when no rename is requested", async () => {
		const node = pdFile("f1", "a.md", "d2");
		protonDriveGetNode.mockResolvedValue(node);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await client.move("f1", undefined, "d2");
		expect(protonDriveMoveNode).toHaveBeenCalledWith({}, "f1", "d2");
		expect(protonDriveRenameNode).not.toHaveBeenCalled();
	});

	it("calls only the rename op when no reparent is requested", async () => {
		protonDriveGetNode.mockResolvedValue(pdFile("f1", "b.md", "root"));
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await client.move("f1", "b.md", undefined);
		expect(protonDriveRenameNode).toHaveBeenCalledWith({}, "f1", "b.md");
		expect(protonDriveMoveNode).not.toHaveBeenCalled();
	});
});

describe("ProtonDriveClient.deleteItem", () => {
	it("is idempotent when the node is already gone", async () => {
		protonDriveTrashNodes.mockRejectedValue(new Error("gone"));
		isProtonDriveNotFoundError.mockReturnValue(true);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await expect(client.deleteItem("f1")).resolves.toBeUndefined();
	});

	it("rethrows any other error", async () => {
		protonDriveTrashNodes.mockRejectedValue(new Error("network blip"));
		isProtonDriveNotFoundError.mockReturnValue(false);
		const { ProtonDriveClient } = await import("./drive-client");
		const client = new ProtonDriveClient({});
		await expect(client.deleteItem("f1")).rejects.toThrow("network blip");
	});
});
