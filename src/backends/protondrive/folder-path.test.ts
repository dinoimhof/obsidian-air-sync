import { describe, expect, it } from "vitest";
import type { DriveNode, NodeUid } from "./drive-api";
import { listMyFilesFolders, parseFolderPath } from "./folder-path";
import type { FolderTreeApi } from "./folder-path";

describe("parseFolderPath", () => {
	it("rejects backslashes and control characters as well as empty, . and .. segments", () => {
		for (const input of ["Notes\\Vault", "a/\tb", "a//b", "a/../b", "./a"]) {
			expect(() => parseFolderPath(input)).toThrow(expect.objectContaining({ kind: "permanent" }));
		}
	});

	it("accepts a nested path with one leading and trailing slash", () => {
		expect([...parseFolderPath("/notes/work vault/")]).toEqual(["notes", "work vault"]);
	});
});

describe("listMyFilesFolders", () => {
	it("never offers a folder whose name is not a safe path segment", async () => {
		const root: DriveNode = { uid: "v~root" as NodeUid, name: "root", kind: "folder", trashed: false, degraded: false };
		const child = (uid: string, name: string): DriveNode => ({ uid: uid as NodeUid, parentUid: root.uid, name, kind: "folder", trashed: false, degraded: false });
		const api: FolderTreeApi = {
			getMyFilesRoot: () => Promise.resolve(root),
			listChildren: () => Promise.resolve([child("v~a", "notes"), child("v~b", "a/b"), child("v~c", "..")]),
			createFolder: () => Promise.reject(new Error("not used")),
		};
		expect(await listMyFilesFolders(api)).toEqual(["notes"]);
	});
});
