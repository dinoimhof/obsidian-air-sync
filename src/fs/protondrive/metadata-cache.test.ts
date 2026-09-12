import { describe, it, expect } from "vitest";
import { ProtonDriveMetadataCache } from "./metadata-cache";
import { pdFile, pdFolder } from "./test-helpers";

const ROOT = "root";

function makeCache() {
	return new ProtonDriveMetadataCache(ROOT);
}

describe("ProtonDriveMetadataCache.buildFromFiles (id-chain resolution)", () => {
	it("resolves paths from parentUid, with the root as the chain anchor", () => {
		const cache = makeCache();
		cache.buildFromFiles([
			pdFolder("d1", "dir", ROOT),
			pdFile("f1", "a.md", ROOT),
			pdFile("f2", "b.md", "d1"),
		]);
		expect(cache.size).toBe(3);
		expect(cache.isFolder("dir")).toBe(true);
		expect(cache.hasFile("a.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(true);
		expect([...cache.getChildren("")!]).toEqual(expect.arrayContaining(["a.md", "dir"]));
		expect([...cache.getChildren("dir")!]).toEqual(["dir/b.md"]);
	});

	it("projects the active revision uid as an opaque checksum + protonDriveUid for files, a bare directory for folders", () => {
		const cache = makeCache();
		cache.buildFromFiles([pdFile("f1", "a.md", ROOT, { size: 5, revisionUid: "rev-1" })]);
		const file = cache.toEntity("a.md", cache.getFile("a.md")!);
		expect(file).toMatchObject({ isDirectory: false, size: 5, hash: "", remoteChecksum: { algo: "opaque", value: "rev-1" } });
		expect(file.backendMeta).toMatchObject({ protonDriveUid: "f1" });

		cache.buildFromFiles([pdFolder("d1", "dir", ROOT)]);
		expect(cache.toEntity("dir", cache.getFile("dir")!)).toMatchObject({
			pathAuthority: "actual_resolved",
			identityKey: "d1",
			isDirectory: true,
			size: 0,
			mtime: 0,
			hash: "",
			remoteChecksum: undefined,
		});
	});

	it("surfaces an undecryptable node with a stable, uid-derived name rather than hiding it", () => {
		const cache = makeCache();
		cache.buildFromFiles([pdFile("f1", "(undecryptable-name-f1)", ROOT)]);
		expect(cache.hasFile("(undecryptable-name-f1)")).toBe(true);
	});
});

describe("ProtonDriveMetadataCache tree mutation", () => {
	it("removeTree drops an entry and all descendants (by uid)", () => {
		const cache = makeCache();
		cache.buildFromFiles([pdFolder("d1", "dir", ROOT), pdFile("f1", "b.md", "d1")]);
		cache.removeTree("dir");
		expect(cache.hasFile("dir")).toBe(false);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(cache.getPathById("f1")).toBeUndefined();
	});

	it("applyFileChangeDetectMove rewrites child paths on a folder rename via the same uid", () => {
		const cache = makeCache();
		cache.buildFromFiles([pdFolder("d1", "dir", ROOT), pdFile("f1", "b.md", "d1")]);
		// The folder is renamed remotely: same uid, new name.
		const result = cache.applyFileChangeDetectMove(pdFolder("d1", "papers", ROOT));
		expect(result).toMatchObject({ oldPath: "dir", newPath: "papers", wasFolder: true });
		expect(cache.hasFile("papers")).toBe(true);
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(cache.hasFile("dir/b.md")).toBe(false);
		expect(cache.getPathById("f1")).toBe("papers/b.md");
	});
});
