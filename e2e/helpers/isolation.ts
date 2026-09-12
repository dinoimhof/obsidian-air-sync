import type { GoogleDriveClient } from "../../src/fs/googledrive/client";
import type { DropboxClient } from "../../src/fs/dropbox/client";
import type { OneDriveClient } from "../../src/fs/onedrive/client";
import type { ProtonDriveClient } from "../../src/fs/protondrive/drive-client";

/**
 * Per-test isolation for the real-cloud contract run.
 *
 * `runIFileSystemContract` rebuilds the FS in `beforeEach` and assumes a CLEAN,
 * EMPTY root each time, but exposes no cleanup hook. So each backend creates ONE
 * throwaway parent folder per run (in `beforeAll`) and a FRESH child folder per
 * test (the `makeFs` factory). The whole tree is removed once in `afterAll` by
 * deleting the parent recursively.
 */

function uniqueName(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Google Drive ──────────────────────────────────────────────────────────

/** Create the per-run parent under "root" (Google Drive's My Drive alias); returns its id. */
export async function makeGoogleDriveParent(client: GoogleDriveClient): Promise<string> {
	const folder = await client.createFolder(uniqueName("airsync-e2e"), "root");
	return folder.id;
}

/** Create a fresh empty child folder under the parent; returns its id (per-test root). */
export async function makeGoogleDriveChild(
	client: GoogleDriveClient,
	parentId: string,
): Promise<string> {
	const folder = await client.createFolder(uniqueName("t"), parentId);
	return folder.id;
}

/** Trash the parent and everything under it. */
export async function cleanupGoogleDriveParent(
	client: GoogleDriveClient,
	parentId: string,
): Promise<void> {
	// Trash, not permanent-delete: the drive.file scope can't hard-delete (403).
	// The per-run unique names keep reruns clean despite trashed leftovers.
	await client.deleteFile(parentId, false);
}

// ── Dropbox ───────────────────────────────────────────────────────────────
//
// Parent and child are created by ABSOLUTE path: `create_folder_v2` rejects an
// `id:<folder>/<sub>` path (it requires `/path` or `ns:<n>`). DropboxFs itself
// addresses by id, and a FRESHLY-created folder's id can transiently 400
// ("did not match pattern") on an id-relative create until it propagates. The
// contract drives a RetryingDropboxClient (dropbox-retry-client.ts) that retries
// that exact transient on the real op, so no pre-use warm-up of the child is needed.

/** Create the per-run parent in the app folder; returns its absolute path. */
export async function makeDropboxParent(client: DropboxClient): Promise<string> {
	const path = `/${uniqueName("airsync-e2e")}`;
	await client.createFolder(path);
	return path;
}

/** Create a fresh empty child folder (absolute path) and return its id (per-test root). */
export async function makeDropboxChild(
	client: DropboxClient,
	parentPath: string,
): Promise<string> {
	const entry = await client.createFolder(`${parentPath}/${uniqueName("t")}`);
	if (!entry.id) throw new Error("Dropbox createFolder returned a folder with no id");
	return entry.id;
}

/** Recursively delete the parent (idempotent: an already-gone path is a no-op). */
export async function cleanupDropboxParent(
	client: DropboxClient,
	parentPath: string,
): Promise<void> {
	await client.deletePath(parentPath);
}

// ── OneDrive ────────────────────────────────────────────────────────────────
//
// The App Folder scope (Files.ReadWrite.AppFolder) confines everything under
// /me/drive/special/approot, so the per-run parent is created directly inside that
// app-root item. OneDrive addresses items by their stable driveItem id (like Google Drive,
// unlike Dropbox's id warm-up dance), so a freshly-created folder id is usable at once.

/** Create the per-run parent under the App Folder root; returns its id. */
export async function makeOneDriveParent(client: OneDriveClient): Promise<string> {
	// Touching `special/approot` provisions the app folder on first access, then we
	// anchor the throwaway tree under its id.
	const appRoot = await client.getAppRoot();
	const folder = await client.createFolder(appRoot.id, uniqueName("airsync-e2e"));
	return folder.id;
}

/** Create a fresh empty child folder under the parent; returns its id (per-test root). */
export async function makeOneDriveChild(
	client: OneDriveClient,
	parentId: string,
): Promise<string> {
	const folder = await client.createFolder(parentId, uniqueName("t"));
	return folder.id;
}

/** Delete the parent and its whole subtree (idempotent: deleteItem no-ops on a 404). */
export async function cleanupOneDriveParent(
	client: OneDriveClient,
	parentId: string,
): Promise<void> {
	await client.deleteItem(parentId);
}

// ── Proton Drive ────────────────────────────────────────────────────────────
//
// No app-folder scoping: the whole account's "My files" is reachable, so the
// per-run parent is created directly under the real Drive root (like Google
// Drive), not a fixed app-root item (unlike OneDrive/Dropbox). Nodes are
// addressed by opaque uid; a freshly-created folder's uid is usable at once.

/** Create the per-run parent under "My files"; returns its uid. */
export async function makeProtonDriveParent(client: ProtonDriveClient): Promise<string> {
	const root = await client.getRootFolder();
	const folder = await client.createFolder(root.uid, uniqueName("airsync-e2e"));
	return folder.uid;
}

/** Create a fresh empty child folder under the parent; returns its uid (per-test root). */
export async function makeProtonDriveChild(
	client: ProtonDriveClient,
	parentUid: string,
): Promise<string> {
	const folder = await client.createFolder(parentUid, uniqueName("t"));
	return folder.uid;
}

/** Trash the parent and its whole subtree (idempotent: deleteItem no-ops when already gone). */
export async function cleanupProtonDriveParent(
	client: ProtonDriveClient,
	parentUid: string,
): Promise<void> {
	await client.deleteItem(parentUid);
}
