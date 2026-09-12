// SPDX-License-Identifier: GPL-3.0-or-later
// This file bundles @protontech/drive-sdk (GPL-3.0) into the distributed main.js;
// see docs/protondrive-backend.md for the licensing rationale. The rest of this
// project (see LICENSE) remains MIT and is unaffected.
import * as driveSdkRuntime from "@protontech/drive-sdk";
import { getRawCryptoProxyForSdk } from "./protondrive-crypto";

const runtimeValue: unknown = driveSdkRuntime;

function isCallable(value: unknown): value is new (...args: never[]) => unknown {
	return typeof value === "function";
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

function driveSdkMember(name: string): unknown {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("@protontech/drive-sdk runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>)[name];
	if (!candidate) throw new Error(`@protontech/drive-sdk ${name} export is unavailable`);
	return candidate;
}

function construct(name: string, args: unknown[]): unknown {
	const candidate = driveSdkMember(name);
	if (!isCallable(candidate)) throw new Error(`@protontech/drive-sdk ${name} is not a constructor`);
	return new candidate(...(args as never[]));
}

/**
 * The installed @protontech/drive-sdk version, required verbatim in the
 * `x-pm-drive-sdk-version` header on every Drive API request per Proton's
 * third-party operational guidelines.
 */
export function protonDriveSdkVersion(): string {
	const candidate = driveSdkMember("VERSION");
	if (typeof candidate !== "string") throw new Error("@protontech/drive-sdk VERSION export is unavailable");
	return candidate;
}

/**
 * A live `ProtonDriveClient` instance. Deliberately `unknown` at this boundary: Step 4
 * of this backend's implementation plan defines a first-party interface covering the
 * exact methods it calls (mirroring how `platform/obsidian.ts` hand-types `Vault`/
 * `App`/etc.), verified against real contract tests rather than transcribed blind here.
 */
export type ProtonDriveClientHandle = unknown;

/** Build the SDK's `MemoryCache` (used for both `entitiesCache` and `cryptoCache`). */
export function createProtonDriveMemoryCache(): unknown {
	return construct("MemoryCache", []);
}

/** Build the SDK's OpenPGP crypto adapter over the already-initialized `CryptoProxy`. */
export function createProtonDriveOpenPGPCrypto(): unknown {
	return construct("OpenPGPCryptoWithCryptoProxy", [getRawCryptoProxyForSdk()]);
}

/**
 * First-party mirror of the SDK's `ProtonDriveClientContructorParameters` field names
 * (see @protontech/drive-sdk's config.d.ts) — each value kept `unknown` since they're
 * themselves sourced from other unsafe-boundary-crossing constructors, but the field
 * names themselves are real, so a typo (e.g. `srpModule` misspelled) is still caught
 * at compile time instead of failing only at runtime.
 */
export interface ProtonDriveClientParams {
	httpClient: unknown;
	entitiesCache: unknown;
	cryptoCache: unknown;
	account: unknown;
	openPGPCryptoModule: unknown;
	srpModule: unknown;
	config: { clientUid: string };
}

/**
 * Construct the real `ProtonDriveClient`. Field values are forwarded to the SDK's
 * constructor as-is (not deeply validated) — the SDK itself is the authority on its
 * own constructor's shape; this boundary's job is only to isolate the untyped import,
 * not to re-implement the SDK's own validation.
 */
export function createProtonDriveClientInstance(params: ProtonDriveClientParams): ProtonDriveClientHandle {
	return construct("ProtonDriveClient", [params]);
}

// ── Node/event operations (Step 4: ProtonDriveFs) ──
//
// The SDK addresses content by opaque `nodeUid`s in a strict single-parent tree
// (`NodeEntity.parentUid`), never by path — see @protontech/drive-sdk's
// interface/nodes.d.ts (confirmed by direct read, not transcribed blind). Every
// function below narrows one `ProtonDriveClient` method (or a value it returns,
// e.g. a `FileUploader`/`FileDownloader`) and projects the result into a
// first-party shape so `src/fs/protondrive/drive-client.ts` never needs its own
// unknown-narrowing — it only ever sees `ProtonDriveNode`/`ProtonDriveEvent`.

function asObject(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null) throw new Error(`Proton Drive: ${context} is unavailable`);
	return value as Record<string, unknown>;
}

/** Call an instance method on any SDK-returned object (the client, an uploader, …). */
function callInstanceMethod(obj: unknown, name: string, args: unknown[]): unknown {
	const rec = asObject(obj, name);
	const candidate = rec[name];
	if (!isFunction(candidate)) throw new Error(`Proton Drive: ${name} is not available`);
	return candidate.apply(rec, args);
}

/** Same as {@link callInstanceMethod}, awaited — works for both sync and async methods. */
async function callAsyncMethod(obj: unknown, name: string, args: unknown[]): Promise<unknown> {
	return await callInstanceMethod(obj, name, args);
}

/**
 * A `NodeEntity` projected into the small set of fields this backend needs.
 * `name` is always a resolved string: an undecryptable name (see the SDK's
 * `Result<string, Error | InvalidNameError>`) is surfaced as a stable,
 * uid-derived placeholder rather than hidden — dropping it silently would read
 * downstream as a deletion (see this repo's "never derive a deletion from
 * listing-absence alone" convention in AGENTS.md).
 */
export interface ProtonDriveNode {
	uid: string;
	parentUid?: string;
	name: string;
	isFolder: boolean;
	isTrashed: boolean;
	/** Encrypted size on the server (see `NodeEntity.activeRevision.storageSize`); 0 for folders. */
	size: number;
	mtime: number;
	/** The active revision's uid — a fresh value on every content change; used as the opaque checksum. */
	revisionUid?: string;
	treeEventScopeId: string;
}

function toProtonDriveNode(raw: unknown): ProtonDriveNode | null {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	const uid = rec.uid;
	const treeEventScopeId = rec.treeEventScopeId;
	if (typeof uid !== "string" || typeof treeEventScopeId !== "string") return null;

	const nameResult = rec.name;
	let name: string;
	if (typeof nameResult === "object" && nameResult !== null && (nameResult as Record<string, unknown>).ok === true
		&& typeof (nameResult as Record<string, unknown>).value === "string") {
		name = (nameResult as Record<string, unknown>).value as string;
	} else {
		name = `(undecryptable-name-${uid})`;
	}

	const parentUid = typeof rec.parentUid === "string" ? rec.parentUid : undefined;
	const isFolder = rec.type === "folder";
	const isTrashed = rec.trashTime !== undefined && rec.trashTime !== null;
	const modificationTime = rec.modificationTime;
	const mtime = modificationTime instanceof Date ? modificationTime.getTime() : 0;

	const activeRevision = rec.activeRevision;
	let revisionUid: string | undefined;
	let size = 0;
	if (typeof activeRevision === "object" && activeRevision !== null) {
		const revRec = activeRevision as Record<string, unknown>;
		if (typeof revRec.uid === "string") revisionUid = revRec.uid;
		if (typeof revRec.storageSize === "number") size = revRec.storageSize;
	}

	return { uid, parentUid, name, isFolder, isTrashed, size, mtime, revisionUid, treeEventScopeId };
}

/** A `ServerError`-shaped failure with a 404 status — matched structurally (see `isCallable`'s rationale). */
export function isProtonDriveNotFoundError(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const rec = err as Record<string, unknown>;
	return rec.name === "ServerError" && rec.statusCode === 404;
}

/** The conflicting node's uid, when `err` is a `NodeWithSameNameExistsValidationError`. */
export function protonDriveExistingNodeUid(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const rec = err as Record<string, unknown>;
	if (rec.name === "NodeWithSameNameExistsValidationError" && typeof rec.existingNodeUid === "string") {
		return rec.existingNodeUid;
	}
	return undefined;
}

function toNodeResult(raw: unknown, fallbackUid: string): { uid: string; ok: boolean; error?: string } {
	if (typeof raw !== "object" || raw === null) return { uid: fallbackUid, ok: false, error: "unexpected result shape" };
	const rec = raw as Record<string, unknown>;
	const uid = typeof rec.uid === "string" ? rec.uid : fallbackUid;
	if (rec.ok === true) return { uid, ok: true };
	const error = rec.error;
	return { uid, ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function protonDriveGetNode(handle: ProtonDriveClientHandle, nodeUid: string): Promise<ProtonDriveNode> {
	const raw = await callAsyncMethod(handle, "getNode", [nodeUid]);
	const node = toProtonDriveNode(raw);
	if (!node) throw new Error(`Proton Drive: node ${nodeUid} has an unexpected shape`);
	return node;
}

/** Children of a folder, via `iterateFolderChildrenNodeUids` + `iterateNodes` (no direct "list children" call). */
export async function* protonDriveIterateFolderChildren(
	handle: ProtonDriveClientHandle,
	parentUid: string,
): AsyncGenerator<ProtonDriveNode> {
	const uids: string[] = [];
	const uidIter = callInstanceMethod(handle, "iterateFolderChildrenNodeUids", [parentUid]) as AsyncGenerator<unknown>;
	for await (const uid of uidIter) {
		if (typeof uid === "string") uids.push(uid);
	}
	if (uids.length === 0) return;
	const nodeIter = callInstanceMethod(handle, "iterateNodes", [uids]) as AsyncGenerator<unknown>;
	for await (const raw of nodeIter) {
		if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).missingUid === "string") {
			continue; // MissingNode: gone between the uid listing and the node fetch.
		}
		const node = toProtonDriveNode(raw);
		if (node) yield node;
	}
}

export async function protonDriveCreateFolder(
	handle: ProtonDriveClientHandle,
	parentUid: string,
	name: string,
): Promise<ProtonDriveNode> {
	const raw = await callAsyncMethod(handle, "createFolder", [parentUid, name]);
	const node = toProtonDriveNode(raw);
	if (!node) throw new Error(`Proton Drive: created folder "${name}" has an unexpected shape`);
	return node;
}

export async function protonDriveRenameNode(
	handle: ProtonDriveClientHandle,
	nodeUid: string,
	newName: string,
): Promise<void> {
	await callAsyncMethod(handle, "renameNode", [nodeUid, newName]);
}

export async function protonDriveMoveNode(
	handle: ProtonDriveClientHandle,
	nodeUid: string,
	newParentUid: string,
): Promise<void> {
	const iter = callInstanceMethod(handle, "moveNodes", [[nodeUid], newParentUid]) as AsyncGenerator<unknown>;
	for await (const raw of iter) {
		const result = toNodeResult(raw, nodeUid);
		if (!result.ok) throw new Error(`Proton Drive: move failed for ${result.uid}: ${result.error}`);
	}
}

/** Soft-delete (trash) — mirrors the other backends' recycle-bin-style delete. */
export async function protonDriveTrashNodes(handle: ProtonDriveClientHandle, nodeUids: string[]): Promise<void> {
	const iter = callInstanceMethod(handle, "trashNodes", [nodeUids]) as AsyncGenerator<unknown>;
	for await (const raw of iter) {
		const result = toNodeResult(raw, nodeUids[0] ?? "");
		if (!result.ok) throw new Error(`Proton Drive: trash failed for ${result.uid}: ${result.error}`);
	}
}

export async function protonDriveGetAvailableName(
	handle: ProtonDriveClientHandle,
	parentUid: string,
	name: string,
): Promise<string> {
	const result = await callAsyncMethod(handle, "getAvailableName", [parentUid, name]);
	if (typeof result !== "string") throw new Error("Proton Drive: getAvailableName returned an unexpected shape");
	return result;
}

function arrayBufferToReadableStream(content: ArrayBuffer): ReadableStream<Uint8Array> {
	const bytes = new Uint8Array(content);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function runUpload(uploader: unknown, content: ArrayBuffer): Promise<{ nodeUid: string; revisionUid: string }> {
	const controller = await callAsyncMethod(uploader, "uploadFromStream", [arrayBufferToReadableStream(content), []]);
	const result = await callAsyncMethod(controller, "completion", []);
	const rec = asObject(result, "upload completion result");
	if (typeof rec.nodeUid !== "string" || typeof rec.nodeRevisionUid !== "string") {
		throw new Error("Proton Drive: upload completion returned an unexpected shape");
	}
	return { nodeUid: rec.nodeUid, revisionUid: rec.nodeRevisionUid };
}

/** Create a brand-new file. Rejects (`NodeWithSameNameExistsValidationError`) if `name` already exists. */
export async function protonDriveUploadFile(
	handle: ProtonDriveClientHandle,
	parentUid: string,
	name: string,
	content: ArrayBuffer,
	mtime: number,
): Promise<{ nodeUid: string; revisionUid: string }> {
	const metadata = { mediaType: "application/octet-stream", expectedSize: content.byteLength, modificationTime: new Date(mtime) };
	const uploader = await callAsyncMethod(handle, "getFileUploader", [parentUid, name, metadata]);
	return runUpload(uploader, content);
}

/** Upload a new revision of an EXISTING file (overwrite) — the counterpart to {@link protonDriveUploadFile}. */
export async function protonDriveUploadRevision(
	handle: ProtonDriveClientHandle,
	nodeUid: string,
	content: ArrayBuffer,
	mtime: number,
): Promise<{ nodeUid: string; revisionUid: string }> {
	const metadata = { mediaType: "application/octet-stream", expectedSize: content.byteLength, modificationTime: new Date(mtime) };
	const uploader = await callAsyncMethod(handle, "getFileRevisionUploader", [nodeUid, metadata]);
	return runUpload(uploader, content);
}

export async function protonDriveDownloadFile(handle: ProtonDriveClientHandle, nodeUid: string): Promise<ArrayBuffer> {
	const downloader = await callAsyncMethod(handle, "getFileDownloader", [nodeUid]);
	const chunks: Uint8Array[] = [];
	const stream = new WritableStream<Uint8Array>({
		write(chunk) { chunks.push(chunk); },
	});
	const controller = callInstanceMethod(downloader, "downloadToStream", [stream]);
	await callAsyncMethod(controller, "completion", []);
	const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result.buffer;
}

/** One event from `iterateEvents` (see @protontech/drive-sdk's interface/events.d.ts). */
export interface ProtonDriveEvent {
	type: "node_created" | "node_updated" | "node_deleted" | "fast_forward" | "tree_refresh" | "tree_remove";
	nodeUid?: string;
	eventId: string;
}

const EVENT_TYPES = new Set(["node_created", "node_updated", "node_deleted", "fast_forward", "tree_refresh", "tree_remove"]);

function toProtonDriveEvent(raw: unknown): ProtonDriveEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	const type = rec.type;
	const eventId = rec.eventId;
	if (typeof type !== "string" || typeof eventId !== "string" || !EVENT_TYPES.has(type)) return null;
	const nodeUid = typeof rec.nodeUid === "string" ? rec.nodeUid : undefined;
	return { type: type as ProtonDriveEvent["type"], nodeUid, eventId };
}

export async function* protonDriveIterateEvents(
	handle: ProtonDriveClientHandle,
	treeEventScopeId: string,
	lastEventId?: string,
): AsyncGenerator<ProtonDriveEvent> {
	const iter = callInstanceMethod(handle, "iterateEvents", [treeEventScopeId, lastEventId]) as AsyncGenerator<unknown>;
	for await (const raw of iter) {
		const event = toProtonDriveEvent(raw);
		if (event) yield event;
	}
}

/**
 * The eventId to start incremental sync from, captured via `iterateEvents` with
 * no `lastEventId` — per the SDK's contract this yields exactly one
 * `FastForwardEvent` carrying the current latest id, with no history replayed.
 */
export async function protonDriveGetStartEventId(handle: ProtonDriveClientHandle, treeEventScopeId: string): Promise<string> {
	const iter = callInstanceMethod(handle, "iterateEvents", [treeEventScopeId]) as AsyncGenerator<unknown>;
	for await (const raw of iter) {
		const event = toProtonDriveEvent(raw);
		if (event) return event.eventId;
	}
	throw new Error("Proton Drive: iterateEvents did not yield a starting event id");
}
