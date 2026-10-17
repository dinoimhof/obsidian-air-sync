import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendRuntimeContext, BackendSecretStore } from "../../backend-api";
import type { DriveNode, NodeUid, ProtonDriveApi } from "./drive-api";
import { FORK_SECRET_KEY, completeFork } from "./fork-login";
import { protonDriveModule } from "./module";
import { ProtonDriveAdapter } from "./adapter";
import { openProtonDrive, releaseProtonDrive, type ProtonConnection } from "./sdk-client";
import type { ProtonSession } from "./session";
import { SESSION_SECRET_KEY, SessionHandle } from "./session";
import { keyPasswordOf } from "./local-key";
import { ProtonTransport } from "./transport";

vi.mock("./sdk-client", () => ({ openProtonDrive: vi.fn(), releaseProtonDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("./fork-login", async (original) => ({ ...(await original<object>()), completeFork: vi.fn() }));

const MY_FILES = "vol~myfiles" as NodeUid;

/** My files and its folder tree, with `createFolder` recording what it made. */
class FolderTree {
	readonly nodes: DriveNode[] = [{ uid: MY_FILES, name: null, kind: "folder", trashed: false, degraded: false }];
	readonly created: string[] = [];

	add(uid: string, parent: NodeUid, name: string, kind: DriveNode["kind"] = "folder"): NodeUid {
		this.nodes.push({ uid: uid as NodeUid, parentUid: parent, name, kind, trashed: false, degraded: false });
		return uid as NodeUid;
	}

	drive(): ProtonDriveApi {
		const unreachable = (): never => {
			throw new Error("not used by binding");
		};
		return {
			getMyFilesRoot: () => Promise.resolve(this.nodes[0]!),
			listChildren: (parent) => Promise.resolve(this.nodes.filter((node) => node.parentUid === parent)),
			createFolder: (parent, name) => {
				this.created.push(name);
				const uid = this.add(`vol~new-${this.created.length}`, parent, name);
				return Promise.resolve(this.nodes.find((node) => node.uid === uid)!);
			},
			getNodes: (uids) => Promise.resolve(new Map(this.nodes.filter((node) => uids.includes(node.uid)).map((node) => [node.uid, node] as const))),
			latestEventId: unreachable,
			readEvents: unreachable,
			downloadRevision: unreachable,
			createFile: unreachable,
			uploadRevision: unreachable,
			rename: unreachable,
			move: unreachable,
			trash: unreachable,
		};
	}
}

let tree: FolderTree;
const context = {} as BackendRuntimeContext;

beforeEach(() => {
	tree = new FolderTree();
	vi.mocked(openProtonDrive).mockResolvedValue({ drive: tree.drive() } as ProtonConnection);
});

describe("protondrive binding.resolveDefault", () => {
	it("binds an existing nested folder path without creating anything", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		const inner = tree.add("vol~inner", notes, "notes");

		const result = await protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/notes" }, "Vault");

		expect(result.target).toEqual({ id: inner });
		expect(result.patch).toEqual({ set: { remoteVaultFolderId: inner } });
		expect(tree.created).toEqual([]);
	});

	it("creates only the missing trailing segment of a folder path", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");

		const result = await protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/work" }, "Vault");

		expect(tree.created).toEqual(["work"]);
		expect(tree.nodes.find((node) => node.uid === result.target.id)).toMatchObject({ parentUid: notes, name: "work" });
	});

	it("rejects a folder path containing ..", async () => {
		tree.add("vol~notes", MY_FILES, "notes");

		await expect(
			protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/../other" }, "Vault"),
		).rejects.toMatchObject({ kind: "permanent", message: expect.not.stringMatching(/notes|other/) as unknown });
		expect(tree.created).toEqual([]);
	});

	it("rejects a folder path through a file", async () => {
		tree.add("vol~file", MY_FILES, "notes", "file");

		await expect(
			protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/notes" }, "Vault"),
		).rejects.toMatchObject({ kind: "permanent", message: expect.not.stringContaining("notes") as unknown });
	});

	it("with a blank folder path, binds the obsidian-air-sync/<vault> default", async () => {
		const result = await protonDriveModule.binding.resolveDefault(context, { folderPath: "  " }, "Vault");

		expect(tree.created).toEqual(["obsidian-air-sync", "Vault"]);
		expect(protonDriveModule.binding.appRoot?.defaultFolderPath("Vault")).toBe("obsidian-air-sync/Vault");
		expect(result.patch.set?.remoteVaultFolderId).toBe(result.target.id);
	});
});

describe("protondrive auth.complete", () => {
	const session = { uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "KP" } as unknown as ProtonSession;

	/** Proton's answer to the local-key registration, and the key it was given. */
	const localKey = { status: 200, registered: "" };

	function signInContext(): { context: BackendRuntimeContext; secrets: Map<string, string>; logged: string[] } {
		const secrets = new Map<string, string>();
		const store: BackendSecretStore = {
			get: (key) => Promise.resolve(secrets.get(key) ?? null),
			set: (key, value) => Promise.resolve(void secrets.set(key, value)),
			delete: (key) => Promise.resolve(void secrets.delete(key)),
		};
		const logged: string[] = [];
		// Record the context too: the failure text travels there, not in the message.
		const log = (message: string, logContext?: Record<string, unknown>) => void logged.push(JSON.stringify([message, logContext]));
		const context = {
			http: {
				request: (request: { url: string; method?: string; body?: unknown }) => {
					if (!request.url.endsWith("/auth/v4/sessions/local/key") || request.method !== "PUT") {
						return Promise.reject(new Error("no request expected"));
					}
					localKey.registered = (JSON.parse(String(request.body)) as { Key: string }).Key;
					const body = localKey.status === 200 ? { Code: 1000 } : { Code: 2001 };
					return Promise.resolve({
						status: localKey.status,
						headers: {},
						text: () => Promise.resolve(JSON.stringify(body)),
						arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
						json: () => Promise.resolve(body),
					});
				},
			},
			secrets: store,
			logger: { debug: log, info: log, warn: log, error: log },
			auth: { openExternal: () => Promise.resolve() },
		} as BackendRuntimeContext;
		return { context, secrets, logged };
	}

	beforeEach(() => {
		localKey.status = 200;
		localKey.registered = "";
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		vi.mocked(completeFork).mockResolvedValue(session);
		vi.mocked(openProtonDrive).mockClear();
	});

	it("binds the configured folder and ends the pending sign-in", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		const inner = tree.add("vol~inner", notes, "notes");
		const { context, secrets } = signInContext();

		const patch = await protonDriveModule.auth.complete(context, "", { folderPath: "notes/notes", pendingAuthState: "1" });

		expect(patch.set?.remoteVaultFolderId).toBe(inner);
		expect(patch.unset).toContain("pendingAuthState");
		expect(secrets.has(SESSION_SECRET_KEY)).toBe(true);
		expect(tree.created).toEqual([]);
	});

	it("leaves the vault unbound without a configured folder", async () => {
		const { context } = signInContext();

		const patch = await protonDriveModule.auth.complete(context, "", { pendingAuthState: "1" });

		expect(patch.set).not.toHaveProperty("remoteVaultFolderId");
		expect(patch.unset).toContain("pendingAuthState");
		expect(openProtonDrive).not.toHaveBeenCalled();
	});

	it("keeps the session when the configured folder cannot be bound", async () => {
		tree.add("vol~file", MY_FILES, "notes", "file");
		const { context, secrets, logged } = signInContext();

		const patch = await protonDriveModule.auth.complete(context, "", { folderPath: "notes/notes", pendingAuthState: "1" });

		expect(patch.set).not.toHaveProperty("remoteVaultFolderId");
		expect(patch.unset).toContain("pendingAuthState");
		expect(secrets.has(SESSION_SECRET_KEY)).toBe(true);
		expect(logged.some((message) => message.includes("could not be bound"))).toBe(true);
		// The configured folder path is the user's own folder structure: never logged.
		expect(logged.some((message) => message.includes("notes"))).toBe(false);
	});
});

describe("protondrive disconnectConfig", () => {
	it("keeps only the configured folder", () => {
		expect(protonDriveModule.disconnectConfig?.({ folderPath: "notes/notes", clientUid: "c", remoteVaultFolderId: "f", pendingAuthState: "1" }))
			.toEqual({ folderPath: "notes/notes" });
	});
});

describe("protondrive binding.listAppRootFolders", () => {
	it("lists only the folders directly under My files", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		tree.add("vol~inner", notes, "inner");
		tree.add("vol~file", MY_FILES, "readme.md", "file");
		tree.add("vol~archive", MY_FILES, "archive");

		expect(await protonDriveModule.binding.listAppRootFolders!(context, {})).toEqual(["archive", "notes"]);
	});
});

describe("protondrive auth.revoke", () => {
	function revokeContext(request: () => Promise<never>): { context: BackendRuntimeContext; secrets: Map<string, string> } {
		const secrets = new Map<string, string>([[FORK_SECRET_KEY, "{}"]]);
		const store: BackendSecretStore = {
			get: (key) => Promise.resolve(secrets.get(key) ?? null),
			set: (key, value) => Promise.resolve(void secrets.set(key, value)),
			delete: (key) => Promise.resolve(void secrets.delete(key)),
		};
		const quiet = () => undefined;
		const context = {
			http: { request },
			secrets: store,
			logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
			auth: { openExternal: () => Promise.resolve() },
		} as BackendRuntimeContext;
		return { context, secrets };
	}

	beforeEach(() => {
		vi.mocked(releaseProtonDrive).mockClear();
		// The transport times requests with window timers, as inside Obsidian.
		vi.stubGlobal("window", { setTimeout, clearTimeout });
	});

	it("drops a pending sign-in and releases the keys without a session", async () => {
		const { context, secrets } = revokeContext(() => Promise.reject(new Error("no request expected")));

		await protonDriveModule.auth.revoke?.(context, {});

		expect(secrets.has(FORK_SECRET_KEY)).toBe(false);
		expect(releaseProtonDrive).toHaveBeenCalledTimes(1);
	});

	it("still drops the pending sign-in and releases the keys when the provider revoke fails", async () => {
		const { context, secrets } = revokeContext(() => Promise.reject(new Error("offline")));
		secrets.set(SESSION_SECRET_KEY, JSON.stringify({ uid: "UID", accessToken: "AT", refreshToken: "RT", sealedKeyPassword: "sealed" }));

		await expect(protonDriveModule.auth.revoke?.(context, {})).rejects.toThrow();

		expect(secrets.has(FORK_SECRET_KEY)).toBe(false);
		expect(releaseProtonDrive).toHaveBeenCalledTimes(1);
	});
});

describe("protondrive binding and module surface", () => {
	it("keeps an already bound folder without any provider call", async () => {
		vi.mocked(openProtonDrive).mockClear();
		const result = await protonDriveModule.binding.resolveDefault(context, { remoteVaultFolderId: "vol~bound" }, "Vault");
		expect(result).toEqual({ patch: {}, target: { id: "vol~bound" } });
		expect(openProtonDrive).not.toHaveBeenCalled();
	});

	it("refuses to resolve a default folder for an empty vault name", async () => {
		await expect(protonDriveModule.binding.resolveDefault(context, {}, "  ")).rejects.toMatchObject({ kind: "permanent" });
	});

	it("lists only the safe folder names directly under My files", async () => {
		tree.add("vol~a", MY_FILES, "notes");
		tree.add("vol~b", MY_FILES, "a/b");
		tree.add("vol~c", MY_FILES, "doc.md", "file");
		expect(await protonDriveModule.binding.listAppRootFolders?.(context, {})).toEqual(["notes"]);
	});

	it("shows the bound folder's path from My files, or nothing for an unknown folder", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		const inner = tree.add("vol~inner", notes, "vault");
		expect(await protonDriveModule.binding.getDisplayPath?.(context, {}, { id: inner })).toEqual({ id: inner, displayPath: "/notes/vault" });
		expect(await protonDriveModule.binding.getDisplayPath?.(context, {}, { id: "vol~missing" })).toBeNull();
	});

	it("builds the adapter over the bound folder", async () => {
		const adapter = await protonDriveModule.createAdapter(context, { clientUid: "c" }, { id: "vol~root" });
		expect(adapter).toBeInstanceOf(ProtonDriveAdapter);
		expect(adapter.addressing).toBe("parent_id");
	});
});

describe("protondrive auth.start", () => {
	it("opens Proton's sign-in page and marks the sign-in as pending", async () => {
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		const opened: string[] = [];
		const values = new Map<string, string>();
		const startContext = {
			http: {
				request: () =>
					Promise.resolve({
						status: 200,
						headers: {},
						text: () => Promise.resolve(""),
						arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
						json: () => Promise.resolve({ Code: 1000, Selector: "SEL", UserCode: "CODE" }),
					}),
			},
			secrets: {
				get: (key: string) => Promise.resolve(values.get(key) ?? null),
				set: (key: string, value: string) => Promise.resolve(void values.set(key, value)),
				delete: (key: string) => Promise.resolve(void values.delete(key)),
			},
			logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
			auth: { openExternal: (url: string) => Promise.resolve(void opened.push(url)) },
		} as BackendRuntimeContext;

		const patch = await protonDriveModule.auth.start(startContext, {});

		expect(opened).toHaveLength(1);
		expect(new URL(opened[0]!).origin).toBe("https://account.proton.me");
		expect(patch.set?.pendingAuthState).toEqual(expect.any(String));
		expect(values.has(FORK_SECRET_KEY)).toBe(true);
	});
});

describe("protondrive local key", () => {
	const fork = { uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "the-key-password" } as unknown as ProtonSession;

	function store(values: Map<string, string>): BackendSecretStore {
		return {
			get: (key) => Promise.resolve(values.get(key) ?? null),
			set: (key, value) => Promise.resolve(void values.set(key, value)),
			delete: (key) => Promise.resolve(void values.delete(key)),
		};
	}

	function answer(status: number, body: Record<string, unknown>) {
		return Promise.resolve({
			status,
			headers: {},
			text: () => Promise.resolve(JSON.stringify(body)),
			arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
			json: () => Promise.resolve(body),
		});
	}

	/** A Proton that holds one local key per session, as auth/v4/sessions/local/key does. */
	function proton(put: { status: number | "network" } = { status: 200 }, get: { status?: number } = {}) {
		let held: string | null = null;
		const deletes: string[] = [];
		const request = (r: { url: string; method?: string; body?: unknown }) => {
			if (r.method === "DELETE") {
				deletes.push(new URL(r.url).pathname);
				return answer(200, { Code: 1000 });
			}
			if (r.url.endsWith("/auth/v4/sessions/local/key") && r.method === "PUT") {
				if (put.status === "network") return Promise.reject(new Error("offline"));
				if (put.status !== 200) return answer(put.status, { Code: 2001 });
				held = (JSON.parse(String(r.body)) as { Key: string }).Key;
				return answer(200, { Code: 1000 });
			}
			if (r.url.endsWith("/auth/v4/sessions/local/key")) {
				if (get.status !== undefined) return answer(get.status, { Code: 2000 });
				return held ? answer(200, { Code: 1000, ClientKey: held }) : answer(401, { Code: 401 });
			}
			if (r.url.endsWith("/auth/v4/refresh")) return answer(401, { Code: 401 });
			return Promise.reject(new Error(`unexpected ${r.url}`));
		};
		return { request, deletes, registered: () => held, revoke: () => void (held = null) };
	}

	async function signIn(http: { request: unknown }, values: Map<string, string>, logged: string[] = []) {
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		vi.mocked(completeFork).mockResolvedValue(fork);
		const log = (message: string) => void logged.push(message);
		const context = {
			http,
			secrets: store(values),
			logger: { debug: log, info: log, warn: log, error: log },
			auth: { openExternal: () => Promise.resolve() },
		} as unknown as BackendRuntimeContext;
		await protonDriveModule.auth.complete(context, "", { pendingAuthState: "1" });
		return context;
	}

	it("local key: sign-in stores only the sealed key password, which Proton's key unlocks", async () => {
		const values = new Map<string, string>();
		const server = proton();
		await signIn(server, values);

		const raw = values.get(SESSION_SECRET_KEY) ?? "";
		expect(raw).not.toContain("the-key-password");
		expect(JSON.parse(raw)).toMatchObject({ uid: "UID", sealedKeyPassword: expect.any(String) as unknown });
		// The client key lives only at Proton: never next to the blob it opens.
		expect(raw).not.toContain(server.registered() ?? "unreachable");

		const handle = await SessionHandle.open(store(values));
		await expect(keyPasswordOf(new ProtonTransport(server as never, handle), handle.current)).resolves.toBe("the-key-password");
	});

	it("local key: a revoked session cannot unlock the stored key password and asks to reconnect", async () => {
		const values = new Map<string, string>();
		const server = proton();
		await signIn(server, values);
		server.revoke();

		const handle = await SessionHandle.open(store(values));
		await expect(keyPasswordOf(new ProtonTransport(server as never, handle), handle.current)).rejects.toMatchObject({ kind: "auth" });
	});

	it("local key: a blob sealed for another session does not decrypt", async () => {
		const values = new Map<string, string>();
		const server = proton();
		await signIn(server, values);
		const stored = JSON.parse(values.get(SESSION_SECRET_KEY) ?? "{}") as Record<string, string>;
		values.set(SESSION_SECRET_KEY, JSON.stringify({ ...stored, uid: "OTHER" }));

		const handle = await SessionHandle.open(store(values));
		await expect(keyPasswordOf(new ProtonTransport(server as never, handle), handle.current)).rejects.toMatchObject({ kind: "auth" });
	});

	it("local key: falls back to a marked plaintext key password only on an explicit permission refusal, warning once without values", async () => {
		const values = new Map<string, string>();
		const logged: string[] = [];
		await signIn(proton({ status: 403 }), values, logged);

		expect(JSON.parse(values.get(SESSION_SECRET_KEY) ?? "{}")).toMatchObject({ keyPassword: "the-key-password", keyPasswordAtRest: "plaintext" });
		expect(logged.filter((line) => line.includes("refused a local key"))).toHaveLength(1);
		expect(logged.join("\n")).not.toContain("the-key-password");
	});
});

describe("protondrive local key failures", () => {
	const fork = { uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "the-key-password" } as unknown as ProtonSession;
	const answer = (status: number, body: Record<string, unknown>) =>
		Promise.resolve({ status, headers: {}, text: () => Promise.resolve(JSON.stringify(body)), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), json: () => Promise.resolve(body) });
	const store = (values: Map<string, string>): BackendSecretStore => ({
		get: (key) => Promise.resolve(values.get(key) ?? null),
		set: (key, value) => Promise.resolve(void values.set(key, value)),
		delete: (key) => Promise.resolve(void values.delete(key)),
	});

	function context(putStatus: number | "network", values: Map<string, string>, deletes: string[]): BackendRuntimeContext {
		const request = (r: { url: string; method?: string }) => {
			if (r.method === "DELETE") return Promise.resolve(void deletes.push(new URL(r.url).pathname)).then(() => answer(200, { Code: 1000 }));
			if (putStatus === "network") return Promise.reject(new Error("offline"));
			return answer(putStatus, { Code: 2001 });
		};
		const quiet = () => undefined;
		return { http: { request }, secrets: store(values), logger: { debug: quiet, info: quiet, warn: quiet, error: quiet }, auth: { openExternal: () => Promise.resolve() } } as unknown as BackendRuntimeContext;
	}

	it.each([400, 408, 422, 500, 503, "network"] as const)("local key: a %s on registration stores nothing, revokes the new session and asks to connect again", async (status) => {
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		vi.mocked(completeFork).mockResolvedValue(fork);
		const values = new Map<string, string>();
		const deletes: string[] = [];

		await expect(protonDriveModule.auth.complete(context(status, values, deletes), "", {})).rejects.toMatchObject({ kind: "auth" });

		expect(values.has(SESSION_SECRET_KEY)).toBe(false);
		expect(deletes).toEqual(["/auth/v4"]);
	});

	it("local key: a transient failure fetching the key is not a reconnect prompt", async () => {
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		const values = new Map<string, string>([[SESSION_SECRET_KEY, JSON.stringify({ uid: "UID", accessToken: "AT", refreshToken: "RT", sealedKeyPassword: "AAAA" })]]);
		const handle = await SessionHandle.open(store(values));
		const transport = new ProtonTransport({ request: () => answer(503, { Code: 2000 }) } as never, handle);
		const err = await keyPasswordOf(transport, handle.current).catch((e: unknown) => e);
		expect(err).toMatchObject({ status: 503 });
		expect(err).not.toMatchObject({ kind: "auth" });
	});

	it("local key: disconnect revokes a session stored in a shape this version does not open", async () => {
		vi.stubGlobal("window", { setTimeout, clearTimeout });
		const values = new Map<string, string>([[SESSION_SECRET_KEY, JSON.stringify({ uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "old" })]]);
		const deletes: string[] = [];
		await protonDriveModule.auth.revoke?.(context(200, values, deletes), {});
		expect(deletes).toEqual(["/auth/v4"]);
	});
});
