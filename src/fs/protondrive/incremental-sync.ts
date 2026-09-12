// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { Logger } from "../../logging/logger";
import type { AbstractMetadataCache } from "../caching/metadata-cache";
import type { IncrementalChangesResult } from "../caching/remote-fs";
import { applyIdDeltaPage, createIdDeltaResult, type IdDeltaEntry } from "../caching/id-delta";
import type { ProtonDriveClient, ProtonDriveEvent, ProtonDriveNode } from "./drive-client";

/** Context for incremental sync. See `OneDriveSyncContext` for why there is no metadataStore here. */
export interface ProtonDriveSyncContext {
	cache: AbstractMetadataCache<ProtonDriveNode>;
	client: ProtonDriveClient;
	rootId: string;
	logger?: Logger;
}

/** Hard cap on events drained per cycle (server not advancing past `lastEventId`?). */
export const EVENT_PAGE_CAP = 10_000;

/**
 * Apply incremental changes from the SDK's `iterateEvents` stream. Unlike Graph's
 * or Google Drive's paginated delta, each event carries only an id and a change
 * kind, not the changed metadata itself — a create/update event re-fetches the
 * node with `getNode` (an ordinary sync cycle's delta batch is small, so this is
 * not the O(n) cost a full listing would be). A `tree_refresh`/`tree_remove` event
 * (the SDK's own server-initiated resync signal, e.g. after the event log's
 * retention window elapsed) requests a full scan, exactly like Google Drive's/
 * OneDrive's HTTP 410 handling.
 *
 * The event scope is shared by the whole tree the sync root lives in (see
 * `ProtonDriveClient.getStartCursor`), so this stream can include nodes outside
 * the configured root — those resolve to no path via `applyFileChangeDetectMove`
 * (their parent chain never reaches `rootId`) and are silently no-ops, the same
 * mechanism that already ignores irrelevant Google Drive changes.
 */
export async function applyProtonDriveEvents(ctx: ProtonDriveSyncContext, cursor: string): Promise<IncrementalChangesResult> {
	const acc = createIdDeltaResult();
	let newCursor = cursor;
	let count = 0;
	for await (const event of ctx.client.fetchEvents(cursor)) {
		if (++count > EVENT_PAGE_CAP) {
			throw new Error(`applyProtonDriveEvents: exceeded ${EVENT_PAGE_CAP} events (server not advancing?)`);
		}
		newCursor = ctx.client.advanceCursor(cursor, event.eventId);

		if (event.type === "tree_refresh" || event.type === "tree_remove") {
			ctx.logger?.info("Proton Drive requested a resync", { type: event.type });
			return { needsFullScan: true, changedPaths: new Set<string>() };
		}
		if (event.type === "fast_forward" || !event.nodeUid) continue;

		applyIdDeltaPage(ctx.cache, acc, [await toEntry(ctx, event)]);
	}

	if (acc.count > 0) {
		ctx.logger?.info("Proton Drive events applied", { changeCount: acc.count });
	}
	return { needsFullScan: false, newToken: newCursor, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** Map one Drive event to a normalized delta entry (a deleted/gone node ⇒ tombstone). */
async function toEntry(ctx: ProtonDriveSyncContext, event: ProtonDriveEvent): Promise<IdDeltaEntry<ProtonDriveNode>> {
	const nodeUid = event.nodeUid!;
	if (event.type === "node_deleted") {
		const priorPath = ctx.cache.getPathById(nodeUid);
		return { id: nodeUid, isFolder: priorPath ? ctx.cache.isFolder(priorPath) : false, file: undefined };
	}
	// A create/update event racing an immediate delete (or trash) of the same node
	// resolves to `null` here too — treated the same as an explicit tombstone.
	const node = await ctx.client.getItem(nodeUid);
	return { id: nodeUid, isFolder: node?.isFolder ?? false, file: node ?? undefined };
}
