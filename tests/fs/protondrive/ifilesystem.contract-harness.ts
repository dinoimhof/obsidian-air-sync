import { describe, expect, it, vi } from "vitest";
import type { ProtonDriveClient, ProtonDriveNode } from "../../../src/fs/protondrive/drive-client";
import { ProtonDriveFs } from "../../../src/fs/protondrive";
import { runIFileSystemContract } from "../contracts/ifilesystem.contract";

vi.mock("obsidian");

const ROOT_UID = "root";

/** An in-memory node, keyed by its stable uid. */
interface FakeNode {
	uid: string;
	name: string;
	parentUid: string;
	isFolder: boolean;
	content?: ArrayBuffer;
	size: number;
	mtime: number;
	/** Bumped on every upload/uploadRevision — mints a fresh "opaque" checksum. */
	revisionSeq: number;
}

/**
 * A CRUD-faithful, in-memory stand-in for {@link ProtonDriveClient} — a
 * uid-addressed node store over which the REAL ProtonDriveFs runs unchanged. It
 * models the SDK subset the FS calls: uid + parentUid addressing, a fresh
 * "opaque" revision uid minted on every content change, and separate
 * create-vs-overwrite upload paths (matching the SDK's `getFileUploader` vs
 * `getFileRevisionUploader` split — see docs/protondrive-backend.md).
 */
function makeFakeProtonDriveClient(): ProtonDriveClient {
	const nodes = new Map<string, FakeNode>();
	nodes.set(ROOT_UID, { uid: ROOT_UID, name: "", parentUid: "", isFolder: true, size: 0, mtime: 0, revisionSeq: 0 });
	let idSeq = 0;
	const newUid = (): string => `id${++idSeq}`;

	const toNode = (n: FakeNode): ProtonDriveNode => ({
		uid: n.uid,
		parentUid: n.parentUid || undefined,
		name: n.name,
		isFolder: n.isFolder,
		isTrashed: false,
		size: n.size,
		mtime: n.mtime,
		revisionUid: n.isFolder ? undefined : `rev-${n.uid}-${n.revisionSeq}`,
		treeEventScopeId: "scope-1",
	});

	const childByName = (parentUid: string, name: string): FakeNode | undefined =>
		[...nodes.values()].find((n) => n.parentUid === parentUid && n.name === name);

	const descendantsOf = (uid: string): FakeNode[] => {
		const out: FakeNode[] = [];
		const stack = [uid];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			for (const n of nodes.values()) {
				if (n.parentUid === cur) { out.push(n); stack.push(n.uid); }
			}
		}
		return out;
	};

	const client = {
		getStartCursor: (_rootUid: string): Promise<string> => Promise.resolve("c0"),
		fullList: (_rootUid: string): Promise<ProtonDriveNode[]> =>
			Promise.resolve([...nodes.values()].filter((n) => n.uid !== ROOT_UID).map(toNode)),
		fetchEvents: function* (): Generator<never> { /* no events used by this contract */ },
		advanceCursor: (cursor: string): string => cursor,
		getItem: (uid: string): Promise<ProtonDriveNode | null> => {
			const n = nodes.get(uid);
			return Promise.resolve(n ? toNode(n) : null);
		},
		getChildByName: (parentUid: string, name: string): Promise<ProtonDriveNode | null> => {
			const n = childByName(parentUid, name);
			return Promise.resolve(n ? toNode(n) : null);
		},
		upload: (parentUid: string, name: string, content: ArrayBuffer, mtime: number): Promise<ProtonDriveNode> => {
			const existing = childByName(parentUid, name);
			const uid = existing && !existing.isFolder ? existing.uid : newUid();
			const node: FakeNode = {
				uid, name, parentUid, isFolder: false,
				content: content.slice(0), size: content.byteLength, mtime,
				revisionSeq: (existing?.revisionSeq ?? 0) + 1,
			};
			nodes.set(uid, node);
			return Promise.resolve(toNode(node));
		},
		uploadRevision: (uid: string, content: ArrayBuffer, mtime: number): Promise<ProtonDriveNode> => {
			const existing = nodes.get(uid);
			if (!existing) return Promise.reject(new Error(`not found: ${uid}`));
			const node: FakeNode = {
				...existing, content: content.slice(0), size: content.byteLength, mtime,
				revisionSeq: existing.revisionSeq + 1,
			};
			nodes.set(uid, node);
			return Promise.resolve(toNode(node));
		},
		createFolder: (parentUid: string, name: string): Promise<ProtonDriveNode> => {
			const existing = childByName(parentUid, name);
			if (existing) return Promise.resolve(toNode(existing));
			const node: FakeNode = { uid: newUid(), name, parentUid, isFolder: true, size: 0, mtime: 0, revisionSeq: 0 };
			nodes.set(node.uid, node);
			return Promise.resolve(toNode(node));
		},
		move: (uid: string, name: string | undefined, newParentUid: string | undefined): Promise<ProtonDriveNode> => {
			const n = nodes.get(uid);
			if (!n) return Promise.reject(new Error(`not found: ${uid}`));
			if (name !== undefined) n.name = name;
			if (newParentUid !== undefined) n.parentUid = newParentUid;
			return Promise.resolve(toNode(n));
		},
		download: (uid: string): Promise<ArrayBuffer> => {
			const n = nodes.get(uid);
			return n?.content !== undefined ? Promise.resolve(n.content.slice(0)) : Promise.reject(new Error(`not found: ${uid}`));
		},
		deleteItem: (uid: string): Promise<void> => {
			for (const d of [nodes.get(uid), ...descendantsOf(uid)]) {
				if (d) nodes.delete(d.uid);
			}
			return Promise.resolve();
		},
		getAvailableName: (_parentUid: string, name: string): Promise<string> => Promise.resolve(name),
	};
	return client as unknown as ProtonDriveClient;
}

// Run the shared IFileSystem contract against the REAL ProtonDriveFs over the fake
// Proton Drive client. Remote backends report hash:"" + remoteChecksum from stat(),
// so computesHashOnStat is false. No metadataStore: the CRUD surface is pure
// in-memory cache work; the checkpoint machinery has its own contract.
export function registerProtonDriveIFileSystemContract(): void {
	runIFileSystemContract("ProtonDriveFs", () => new ProtonDriveFs(makeFakeProtonDriveClient(), ROOT_UID), {
		computesHashOnStat: false,
		stableIdentity: true,
	});

	describe("ProtonDriveFs mutation provenance", () => {
		it("returns stable native identities without claiming requested casing was resolved", async () => {
			const fs = new ProtonDriveFs(makeFakeProtonDriveClient(), ROOT_UID);

			const folder = await fs.mkdir("Docs");
			const file = await fs.write("Docs/a.md", new Uint8Array([1]).buffer, 1000);

			expect(folder).toMatchObject({ path: "Docs", pathAuthority: "requested_echo" });
			expect(file).toMatchObject({ path: "Docs/a.md", pathAuthority: "requested_echo" });
			expect(folder.identityKey).toMatch(/^id/);
			expect(file.identityKey).toMatch(/^id/);
			expect(file.identityKey).not.toBe(folder.identityKey);
		});
	});
}
