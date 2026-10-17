import { failBackend } from "../shared/error-shape";
import type { DriveNode, ProtonDriveApi } from "./drive-api";

declare const folderPathBrand: unique symbol;

/** Folder names from My files down; none is empty, `.` or `..`. */
export type FolderPath = readonly string[] & { readonly [folderPathBrand]: true };

export type FolderTreeApi = Pick<ProtonDriveApi, "getMyFilesRoot" | "listChildren" | "createFolder">;

/** Parse a user-typed `/`-separated path under My files; one leading and trailing `/` are ignored. */
export function parseFolderPath(input: string): FolderPath {
	const trimmed = input.trim().replace(/^\//, "").replace(/\/$/, "");
	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (segment.trim() === "" || segment === "." || segment === "..") {
			failBackend("permanent", "The Proton Drive folder path is not valid: every segment must be a folder name (no empty, \".\" or \"..\" segment).");
		}
	}
	return segments as unknown as FolderPath;
}

/** Walk `path` from My files, creating only the missing trailing folders. */
export async function findOrCreateFolderPath(drive: FolderTreeApi, path: FolderPath): Promise<DriveNode> {
	let folder = await drive.getMyFilesRoot();
	for (const [index, name] of path.entries()) {
		const existing = (await drive.listChildren(folder.uid)).find((child) => child.name === name);
		if (!existing) {
			folder = await drive.createFolder(folder.uid, name);
		} else if (existing.kind !== "folder") {
			failBackend("permanent", `Segment ${index + 1} of the Proton Drive folder path already exists and is not a folder.`);
		} else {
			folder = existing;
		}
	}
	return folder;
}

/** Names of the folders directly under My files, sorted. */
export async function listMyFilesFolders(drive: FolderTreeApi): Promise<string[]> {
	const root = await drive.getMyFilesRoot();
	return (await drive.listChildren(root.uid))
		.flatMap((child) => (child.kind === "folder" && child.name !== null ? [child.name] : []))
		.sort((a, b) => a.localeCompare(b));
}
