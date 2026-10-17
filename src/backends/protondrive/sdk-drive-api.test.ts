import { describe, expect, it } from "vitest";
import type { DriveEvent, ProtonDriveClient } from "@protontech/drive-sdk";
import { DriveEventType } from "@protontech/drive-sdk";
import type { EventId, TreeScopeId } from "./drive-api";
import { SdkDriveApi } from "./sdk-drive-api";

function apiWithEvents(events: readonly unknown[]): SdkDriveApi {
	const client = {
		iterateEvents: async function* () {
			for (const event of events) yield event as DriveEvent;
			await Promise.resolve();
		},
	} as unknown as ProtonDriveClient;
	return new SdkDriveApi(client);
}

const node = (type: DriveEventType, nodeUid: string, eventId: string) => ({ type, nodeUid, eventId, treeEventScopeId: "vol" });
const read = (events: readonly unknown[]) => apiWithEvents(events).readEvents("vol" as TreeScopeId, "e0" as EventId);

describe("SdkDriveApi.readEvents: the events feed", () => {
	it("collects touched nodes once and advances to the last event", async () => {
		await expect(read([
			node(DriveEventType.NodeCreated, "vol~a", "e1"),
			node(DriveEventType.NodeUpdated, "vol~a", "e2"),
			node(DriveEventType.NodeDeleted, "vol~b", "e3"),
		])).resolves.toEqual({ kind: "events", touched: ["vol~a", "vol~b"], lastEventId: "e3" });
	});

	it("advances past fast-forward and shared-with-me events without touching nodes", async () => {
		await expect(read([
			{ type: DriveEventType.FastForward, treeEventScopeId: "vol", eventId: "e4" },
			{ type: DriveEventType.SharedWithMeUpdated, eventId: "e5", treeEventScopeId: "core" },
		])).resolves.toEqual({ kind: "events", touched: [], lastEventId: "e5" });
	});

	it("asks for a rescan on a tree refresh", async () => {
		await expect(read([{ type: DriveEventType.TreeRefresh, treeEventScopeId: "vol", eventId: "e6" }])).resolves.toEqual({ kind: "refresh" });
	});

	it("asks for a rescan on an event type it does not know, instead of skipping it", async () => {
		await expect(read([
			node(DriveEventType.NodeCreated, "vol~a", "e1"),
			{ type: "node_moved_v2", nodeUid: "vol~c", treeEventScopeId: "vol", eventId: "e7" },
		])).resolves.toEqual({ kind: "refresh" });
	});

	it("fails when the volume is no longer accessible", async () => {
		await expect(read([{ type: DriveEventType.TreeRemove, treeEventScopeId: "vol", eventId: "e8" }])).rejects.toMatchObject({ kind: "not_found" });
	});
});
