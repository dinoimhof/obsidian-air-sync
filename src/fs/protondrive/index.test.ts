import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { ProtonDriveNode } from "./drive-client";
import { pdFile, pdFolder } from "./test-helpers";

const ROOT = "root";

/**
 * A minimal in-memory fake of {@link ProtonDriveClient}'s surface — an id-addressed
 * node tree, mirroring how `OneDriveFs`/`GoogleDriveFs` are tested against a fake
 * wrapper client rather than the real SDK. `ProtonDriveFs` only ever calls the
 * methods below; it never sees the real `@protontech/drive-sdk`.
 */
class FakeProtonDriveClient {
	nodes = new Map<string, ProtonDriveNode>();
	private nextId = 1;

	constructor(root: ProtonDriveNode) {
		this.nodes.set(root.uid, root);
	}

	private newUid(): string {
		return `n${this.nextId++}`;
	}

	getItem(uid: string): Promise<ProtonDriveNode | null> {
		const node = this.nodes.get(uid);
		return Promise.resolve(node && !node.isTrashed ? node : null);
	}

	listChildren(parentUid: string): Promise<ProtonDriveNode[]> {
		return Promise.resolve([...this.nodes.values()].filter((n) => n.parentUid === parentUid && !n.isTrashed));
	}

	async getChildByName(parentUid: string, name: string): Promise<ProtonDriveNode | null> {
		return (await this.listChildren(parentUid)).find((n) => n.name === name) ?? null;
	}

	async fullList(rootUid: string): Promise<ProtonDriveNode[]> {
		const result: ProtonDriveNode[] = [];
		const queue = [rootUid];
		while (queue.length > 0) {
			const parentUid = queue.shift()!;
			const children = await this.listChildren(parentUid);
			for (const child of children) {
				result.push(child);
				if (child.isFolder) queue.push(child.uid);
			}
		}
		return result;
	}

	getStartCursor(): Promise<string> {
		return Promise.resolve("cursor-0");
	}

	async *fetchEvents(): AsyncGenerator<never> {
		// No events in these tests — every scenario reaches its assertions via a fresh full scan.
	}

	advanceCursor(cursor: string): string {
		return cursor;
	}

	async createFolder(parentUid: string, name: string): Promise<ProtonDriveNode> {
		const existing = await this.getChildByName(parentUid, name);
		if (existing?.isFolder) return existing;
		const node = pdFolder(this.newUid(), name, parentUid);
		this.nodes.set(node.uid, node);
		return node;
	}

	upload(parentUid: string, name: string, content: ArrayBuffer, mtime: number): Promise<ProtonDriveNode> {
		const uid = this.newUid();
		const node = pdFile(uid, name, parentUid, { size: content.byteLength, mtime, revisionUid: `rev-${uid}-1` });
		this.nodes.set(uid, node);
		return Promise.resolve(node);
	}

	uploadRevision(uid: string, content: ArrayBuffer, mtime: number): Promise<ProtonDriveNode> {
		const existing = this.nodes.get(uid);
		if (!existing) throw new Error(`not found: ${uid}`);
		const node = { ...existing, size: content.byteLength, mtime, revisionUid: `${existing.revisionUid}+` };
		this.nodes.set(uid, node);
		return Promise.resolve(node);
	}

	download(uid: string): Promise<ArrayBuffer> {
		const node = this.nodes.get(uid);
		if (!node) throw new Error(`not found: ${uid}`);
		return Promise.resolve(new ArrayBuffer(node.size));
	}

	move(uid: string, newName: string | undefined, newParentUid: string | undefined): Promise<ProtonDriveNode> {
		const node = this.nodes.get(uid);
		if (!node) throw new Error(`not found: ${uid}`);
		const updated = { ...node, name: newName ?? node.name, parentUid: newParentUid ?? node.parentUid };
		this.nodes.set(uid, updated);
		return Promise.resolve(updated);
	}

	deleteItem(uid: string): Promise<void> {
		const node = this.nodes.get(uid);
		if (node) this.nodes.set(uid, { ...node, isTrashed: true });
		return Promise.resolve();
	}

	getAvailableName(_parentUid: string, name: string): Promise<string> {
		return Promise.resolve(name);
	}
}

async function makeFs() {
	const { ProtonDriveFs } = await import("./index");
	const client = new FakeProtonDriveClient(pdFolder(ROOT, "", ""));
	const fs = new ProtonDriveFs(client as never, ROOT);
	return { fs, client };
}

describe("ProtonDriveFs CRUD + listing", () => {
	it("mkdir creates nested folders and write creates a file inside", async () => {
		const { fs } = await makeFs();
		await fs.mkdir("notes/inbox");
		const entity = await fs.write("notes/inbox/todo.md", new TextEncoder().encode("hello").buffer, 1000);

		expect(entity.isDirectory).toBe(false);
		expect(entity.size).toBe(5);
		expect(entity.remoteChecksum?.algo).toBe("opaque");

		const listed = await fs.list();
		const paths = listed.map((e) => e.path).sort();
		expect(paths).toEqual(["notes", "notes/inbox", "notes/inbox/todo.md"]);
	});

	it("write to an existing path overwrites content and mints a new opaque checksum", async () => {
		const { fs } = await makeFs();
		const first = await fs.write("a.md", new TextEncoder().encode("v1").buffer, 1000);
		const second = await fs.write("a.md", new TextEncoder().encode("v2-longer").buffer, 2000);

		expect(second.size).toBe(9);
		expect(second.remoteChecksum?.value).not.toBe(first.remoteChecksum?.value);
		expect((await fs.list()).filter((e) => e.path === "a.md")).toHaveLength(1);
	});

	it("stat returns a bare directory entity for a folder (no remoteChecksum)", async () => {
		const { fs } = await makeFs();
		await fs.mkdir("dir");
		const entity = await fs.stat("dir");
		expect(entity).toMatchObject({ isDirectory: true, size: 0, remoteChecksum: undefined });
	});

	it("rename moves a file to a new folder and updates its name", async () => {
		const { fs } = await makeFs();
		await fs.write("old.md", new TextEncoder().encode("x").buffer, 1000);
		await fs.mkdir("archive");

		await fs.rename("old.md", "archive/new.md");

		expect(await fs.stat("old.md")).toBeNull();
		expect(await fs.stat("archive/new.md")).not.toBeNull();
	});

	it("rename of a folder rewrites all descendant cache paths", async () => {
		const { fs } = await makeFs();
		await fs.mkdir("dir");
		await fs.write("dir/child.md", new TextEncoder().encode("x").buffer, 1000);

		await fs.rename("dir", "renamed");

		expect(await fs.stat("dir/child.md")).toBeNull();
		expect(await fs.stat("renamed/child.md")).not.toBeNull();
	});

	it("delete trashes the remote node and removes it (and descendants) from the cache", async () => {
		const { fs, client } = await makeFs();
		await fs.mkdir("dir");
		await fs.write("dir/child.md", new TextEncoder().encode("x").buffer, 1000);
		const folderUid = (await fs.stat("dir"))!.identityKey!;

		await fs.delete("dir");

		expect(await fs.stat("dir")).toBeNull();
		expect(await fs.stat("dir/child.md")).toBeNull();
		expect(client.nodes.get(folderUid)?.isTrashed).toBe(true);
	});

	it("read downloads a file's content by its provider uid", async () => {
		const { fs } = await makeFs();
		await fs.write("a.md", new TextEncoder().encode("hello world").buffer, 1000);
		const content = await fs.read("a.md");
		expect(content.byteLength).toBe(11);
	});
});
