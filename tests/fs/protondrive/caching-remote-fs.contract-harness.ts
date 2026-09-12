import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { ProtonDriveClient, ProtonDriveEvent, ProtonDriveNode } from "../../../src/fs/protondrive/drive-client";
import { MetadataStore } from "../../../src/store/metadata-store";
import { ProtonDriveFs } from "../../../src/fs/protondrive";
import { pdFile, pdFolder } from "../../../src/fs/protondrive/test-helpers";
import { runCachingRemoteFsContract } from "../contracts/caching-remote-fs.contract";
import type { CachingRemoteFsHarness } from "../contracts/caching-remote-fs.contract";

vi.mock("obsidian");

const ROOT_UID = "root";

/**
 * Run the shared base crash-safety contract (ADR 0001) against the REAL
 * ProtonDriveFs over a minimal in-memory ProtonDriveClient — a baseline of nodes
 * (full enumeration) plus a monotonic, append-only event log keyed by a numeric
 * cursor. A stale cursor is honoured by yielding the events after it; each event
 * carries only a uid + kind (matching the SDK's `iterateEvents`), re-resolved via
 * `getItem` — see `src/fs/protondrive/incremental-sync.ts`. This proves Proton
 * Drive's ADR 0001 path-1 behaviour through the ProtonDriveFs seams (getStartCursor
 * / fullList / fetchEvents), including same-process abort/reload.
 */
function makeProtonDriveHarness(): CachingRemoteFsHarness<ProtonDriveNode> {
	const baseline = new Map<string, { uid: string; node: ProtonDriveNode }>(); // path → node
	const nodeByUid = new Map<string, ProtonDriveNode>();
	// Seeded so assertRootAlive() (getItem(rootId)) resolves even when the baseline
	// is otherwise empty — an empty full list must read as "genuinely empty", not
	// "root deleted".
	nodeByUid.set(ROOT_UID, pdFolder(ROOT_UID, "", ""));
	const events: ProtonDriveEvent[] = []; // append-only
	let idSeq = 0;
	let failAfterFirstPage = false;
	const cursorAt = (n: number): string => `e${n}`;

	const client = {
		getStartCursor: (): Promise<string> => Promise.resolve(cursorAt(events.length)),
		getItem: (uid: string): Promise<ProtonDriveNode | null> => Promise.resolve(nodeByUid.get(uid) ?? null),
		fullList: (): Promise<ProtonDriveNode[]> => Promise.resolve([...baseline.values()].map((e) => e.node)),
		fetchEvents: function* (cursor: string): Generator<ProtonDriveEvent> {
			const from = Number(cursor.slice(1));
			if (failAfterFirstPage) {
				failAfterFirstPage = false;
				if (events.length > from) yield events[from]!;
				throw new Error("injected later page failure");
			}
			for (let i = from; i < events.length; i++) yield events[i]!;
		},
		advanceCursor: (_cursor: string, eventId: string): string => eventId,
	} as unknown as ProtonDriveClient;

	return {
		makeStore: (id) => new MetadataStore<ProtonDriveNode>(id, { dbNamePrefix: "air-sync-protondrive-contract", version: 1 }),
		makeFs: (store) => new ProtonDriveFs(client, ROOT_UID, undefined, store),
		seedFile: (path) => {
			const uid = `f${++idSeq}`;
			const node = pdFile(uid, path, ROOT_UID);
			baseline.set(path, { uid, node });
			nodeByUid.set(uid, node);
		},
		seedFolderWithChild: (folderPath, childName) => {
			const folderUid = `d${++idSeq}`;
			const childUid = `f${++idSeq}`;
			const folder = pdFolder(folderUid, folderPath, ROOT_UID);
			const child = pdFile(childUid, childName, folderUid);
			baseline.set(folderPath, { uid: folderUid, node: folder });
			baseline.set(`${folderPath}/${childName}`, { uid: childUid, node: child });
			nodeByUid.set(folderUid, folder);
			nodeByUid.set(childUid, child);
		},
		stageRemoteDelete: (path) => {
			const entry = baseline.get(path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(path);
			nodeByUid.delete(entry.uid);
			events.push({ type: "node_deleted", nodeUid: entry.uid, eventId: cursorAt(events.length + 1) });
		},
		failNextDeltaAfterFirstPage: () => { failAfterFirstPage = true; },
		// Proton Drive is uid-addressed: a rename re-emits the node with its new name
		// (parentUid unchanged). A folder's children keep their parent uid, so only the
		// folder's own node is re-emitted — the cache reparents the subtree.
		stageRemoteRename: (oldPath, newPath, opts) => {
			const entry = baseline.get(oldPath);
			if (!entry) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
			const oldPrefix = oldPath + "/";
			for (const [p, e] of [...baseline.entries()]) {
				const isSelf = p === oldPath;
				if (!isSelf && !(opts?.isFolder && p.startsWith(oldPrefix))) continue;
				baseline.delete(p);
				baseline.set(isSelf ? newPath : newPath + "/" + p.substring(oldPrefix.length), e);
			}
			const newName = newPath.split("/").pop()!;
			const updated = { ...entry.node, name: newName };
			nodeByUid.set(entry.uid, updated);
			events.push({ type: "node_updated", nodeUid: entry.uid, eventId: cursorAt(events.length + 1) });
		},
	};
}

export function registerProtonDriveCachingContract(): void {
	runCachingRemoteFsContract("ProtonDriveFs", makeProtonDriveHarness);
}
