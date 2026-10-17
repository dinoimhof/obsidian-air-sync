import { describe, expect, it } from "vitest";
import { ProtonDriveAdapter } from "./adapter";
import type { DriveNode, NodeUid, ProtonDriveApi } from "./drive-api";

const ROOT = "vol~root" as NodeUid;
const OUTSIDE = "vol~outside" as NodeUid;
const VOLUME_ROOT = "vol~myfiles" as NodeUid;

function folder(uid: string, parentUid: NodeUid, name: string | null): DriveNode {
	return { uid: uid as NodeUid, parentUid, name, kind: "folder", trashed: false, degraded: false };
}

/** Only the reads `listAll`/`getChanges` make. */
function drive(nodes: readonly DriveNode[], touched: readonly NodeUid[] = []): ProtonDriveApi {
	const byUid = new Map(nodes.map((node) => [node.uid, node]));
	const unreachable = (): never => {
		throw new Error("not used by this test");
	};
	return {
		getMyFilesRoot: unreachable,
		getNodes: (uids) => Promise.resolve(new Map(uids.flatMap((uid) => (byUid.has(uid) ? [[uid, byUid.get(uid)!] as const] : [])))),
		listChildren: (parent) => Promise.resolve(nodes.filter((node) => node.parentUid === parent)),
		latestEventId: unreachable,
		readEvents: (_scope, since) => Promise.resolve({ kind: "events", touched, lastEventId: since }),
		downloadRevision: unreachable,
		createFile: unreachable,
		uploadRevision: unreachable,
		createFolder: unreachable,
		rename: unreachable,
		move: unreachable,
		trash: unreachable,
	};
}

const tree: DriveNode[] = [
	// My files: the volume root has no parent.
	{ uid: VOLUME_ROOT, name: "My files", kind: "folder", trashed: false, degraded: false },
	folder("vol~root", VOLUME_ROOT, "vault"),
	folder("vol~outside", VOLUME_ROOT, "elsewhere"),
	folder("vol~sub", ROOT, "sub"),
];

describe("ProtonDriveAdapter with an undecryptable name", () => {
	it("fails the listing when the node is inside the bound root", async () => {
		const adapter = new ProtonDriveAdapter(drive([...tree, folder("vol~bad", "vol~sub" as NodeUid, null)]), ROOT);
		await expect(adapter.listAll()).rejects.toMatchObject({ kind: "unverifiable" });
	});

	it("fails the delta when a touched node inside the bound root is unnamed", async () => {
		const bad = folder("vol~bad", "vol~sub" as NodeUid, null);
		const adapter = new ProtonDriveAdapter(drive([...tree, bad], [bad.uid]), ROOT);
		await expect(adapter.getChanges("event-1")).rejects.toMatchObject({ kind: "unverifiable" });
	});

	it("reports an unnamed node outside the bound root as gone from the view", async () => {
		const bad = folder("vol~bad", OUTSIDE, null);
		const adapter = new ProtonDriveAdapter(drive([...tree, bad], [bad.uid]), ROOT);
		expect(await adapter.getChanges("event-1")).toEqual({
			kind: "changes",
			nextCursor: "event-1",
			changes: [{ kind: "delete", id: "vol~bad" }],
		});
	});
});

describe("ProtonDriveAdapter with an unsafe name", () => {
	for (const name of ["..", ".", "a/b", "a\\b", "evil\u0000", "line\nbreak", "del\u007f"]) {
		it(`fails the listing for ${JSON.stringify(name)} inside the bound root`, async () => {
			const adapter = new ProtonDriveAdapter(drive([...tree, folder("vol~bad", "vol~sub" as NodeUid, name)]), ROOT);
			await expect(adapter.listAll()).rejects.toMatchObject({ kind: "unverifiable" });
		});
	}

	it("reports an unsafe-named node provably outside the root as gone from the view", async () => {
		const bad = folder("vol~bad", OUTSIDE, "..");
		const adapter = new ProtonDriveAdapter(drive([...tree, bad], [bad.uid]), ROOT);
		expect(await adapter.getChanges("event-1")).toEqual({
			kind: "changes",
			nextCursor: "event-1",
			changes: [{ kind: "delete", id: "vol~bad" }],
		});
	});

	it("fails closed when an unsafe-named node's ancestry cannot be read", async () => {
		const bad = folder("vol~bad", "vol~missing" as NodeUid, "..");
		const adapter = new ProtonDriveAdapter(drive([...tree, bad], [bad.uid]), ROOT);
		await expect(adapter.getChanges("event-1")).rejects.toMatchObject({ kind: "unverifiable" });
	});

	it("names the escaped unsafe name so the user can find the node", async () => {
		const adapter = new ProtonDriveAdapter(drive([...tree, folder("vol~bad", "vol~sub" as NodeUid, "a\tb")]), ROOT);
		await expect(adapter.listAll()).rejects.toMatchObject({ message: expect.stringContaining('"a\\tb"') as unknown });
	});

	it("refuses to write a name the read side would reject, before any provider call", async () => {
		const adapter = new ProtonDriveAdapter(drive(tree), ROOT);
		const destination = { addressing: "parent_id" as const, parentId: ROOT, name: "a\tb.md" };
		await expect(adapter.createFile({ destination, content: new ArrayBuffer(0), mtimeMs: 0 })).rejects.toMatchObject({ kind: "permanent" });
		await expect(adapter.createDirectory({ destination })).rejects.toMatchObject({ kind: "permanent" });
		await expect(
			adapter.move({ id: "vol~sub", expected: { id: "vol~sub", versionToken: "" }, destination }),
		).rejects.toMatchObject({ kind: "permanent" });
	});

	it("still lists ordinary names, including dots and spaces inside them", async () => {
		const adapter = new ProtonDriveAdapter(drive([...tree, folder("vol~ok", "vol~sub" as NodeUid, "my notes.v2 (1)")]), ROOT);
		expect((await adapter.listAll()).map((object) => object.name).sort()).toEqual(["my notes.v2 (1)", "sub"]);
	});
});

describe("ProtonDriveAdapter version-bound read", () => {
	async function sha1(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
		return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	async function adapterServing(claimed: string, served: string) {
		const file: DriveNode = {
			uid: "vol~note" as NodeUid,
			parentUid: ROOT,
			name: "note.md",
			kind: "file",
			trashed: false,
			degraded: false,
			revision: { uid: "vol~note~rev1" as never, size: claimed.length, sha1: await sha1(new TextEncoder().encode(claimed)) },
		};
		const base = drive([...tree, file]);
		const servedBytes = new TextEncoder().encode(served);
		return new ProtonDriveAdapter(
			{ ...base, downloadRevision: () => Promise.resolve({ kind: "content", bytes: servedBytes.buffer.slice(0) }) },
			ROOT,
		);
	}

	it("returns content whose bytes match the claimed SHA-1", async () => {
		const adapter = await adapterServing("hello", "hello");
		await expect(adapter.read({ id: "vol~note", versionToken: "vol~note~rev1" })).resolves.toMatchObject({ kind: "content" });
	});

	it("refuses content whose bytes disagree with the claimed SHA-1", async () => {
		const adapter = await adapterServing("hello", "hellO");
		await expect(adapter.read({ id: "vol~note", versionToken: "vol~note~rev1" })).resolves.toMatchObject({ kind: "unverifiable" });
	});
});

describe("ProtonDriveAdapter move", () => {
	function file(uid: string, parentUid: NodeUid, name: string): DriveNode {
		return { uid: uid as NodeUid, parentUid, name, kind: "file", trashed: false, degraded: false, revision: { uid: `${uid}~r` as never, size: 1 } };
	}

	/** A tree whose rename/move apply in place and record their order. */
	function mutableDrive(nodes: DriveNode[]) {
		const calls: string[] = [];
		const byUid = (uid: NodeUid) => nodes.findIndex((node) => node.uid === uid);
		const api: ProtonDriveApi = {
			...drive(nodes),
			getNodes: (uids) => Promise.resolve(new Map(uids.flatMap((uid) => { const n = nodes[byUid(uid)]; return n ? [[uid, n] as const] : []; }))),
			listChildren: (parent) => Promise.resolve(nodes.filter((node) => node.parentUid === parent)),
			rename: (uid, name) => {
				calls.push(`rename:${name}`);
				const i = byUid(uid);
				nodes[i] = { ...nodes[i]!, name };
				return Promise.resolve();
			},
			move: (uid, parent) => {
				calls.push(`move:${parent}`);
				const i = byUid(uid);
				nodes[i] = { ...nodes[i]!, parentUid: parent };
				return Promise.resolve();
			},
		};
		return { api, calls };
	}

	const SUB = "vol~sub" as NodeUid;
	const run = (api: ProtonDriveApi, name: string, parentId: NodeUid) =>
		new ProtonDriveAdapter(api, ROOT).move({
			id: "vol~note",
			expected: { id: "vol~note", versionToken: "vol~note~r" },
			destination: { addressing: "parent_id", parentId, name },
		});

	it("renames in the source folder, then moves, when nothing clashes", async () => {
		const { api, calls } = mutableDrive([...tree, file("vol~note", ROOT, "a.md")]);
		await run(api, "b.md", SUB);
		expect(calls).toEqual(["rename:b.md", `move:${SUB}`]);
	});

	it("moves first when the new name is taken in the source folder", async () => {
		const { api, calls } = mutableDrive([...tree, file("vol~note", ROOT, "a.md"), file("vol~other", ROOT, "b.md")]);
		const moved = await run(api, "b.md", SUB);
		expect(calls).toEqual([`move:${SUB}`, "rename:b.md"]);
		expect(moved).toMatchObject({ name: "b.md", location: { parentId: SUB } });
	});

	it("fails before any provider call when the destination is occupied", async () => {
		const { api, calls } = mutableDrive([...tree, file("vol~note", ROOT, "a.md"), file("vol~taken", SUB, "b.md")]);
		await expect(run(api, "b.md", SUB)).rejects.toMatchObject({ kind: "target_changed" });
		expect(calls).toEqual([]);
	});

	it("fails before any provider call when both orders would clash", async () => {
		const { api, calls } = mutableDrive([
			...tree, file("vol~note", ROOT, "a.md"), file("vol~src", ROOT, "b.md"), file("vol~dst", SUB, "a.md"),
		]);
		await expect(run(api, "b.md", SUB)).rejects.toMatchObject({ kind: "target_changed" });
		expect(calls).toEqual([]);
	});
});
