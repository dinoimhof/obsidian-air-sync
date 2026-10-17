import type {
	BackendAuth,
	BackendBinding,
	BackendModule,
	BackendRuntimeContext,
	BindingResult,
	JsonObject,
	RemoteBackendAdapter,
} from "../../backend-api";
import {
	APP_ROOT_FOLDER_PATH_KEY,
	BACKEND_MODULE_API_VERSION,
	REMOTE_VAULT_ROOT,
	errorMessage,
	sleep,
} from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import { asString, resolveFolderTarget } from "../shared/module-utils";
import { ProtonDriveAdapter } from "./adapter";
import { PROTON_MODULE_VERSION } from "./constants";
import type { DriveNode, NodeUid } from "./drive-api";
import { findOrCreateFolderPath, listMyFilesFolders, parseFolderPath } from "./folder-path";
import { FORK_SECRET_KEY, beginFork, completeFork } from "./fork-login";
import type { ClientUid, ProtonConnection } from "./sdk-client";
import { SESSION_SECRET_KEY, SessionHandle, loadSessionTokens, saveSession } from "./session";
import { ProtonTransport } from "./transport";
import { sealKeyPassword } from "./local-key";
import { scrubbingLogger } from "./redact";

/**
 * The SDK, its crypto and the polyfills load on first Proton Drive use, not when Air Sync
 * loads: an install that never uses Proton Drive never evaluates them, so a runtime that
 * cannot run them breaks only this backend, never the others.
 */
let sdkLoading: Promise<typeof import("./sdk-client")> | null = null;
// Memoized: a bundler's lazy-init wrapper marks a module loaded before it finishes, so a
// failed first load must keep its original error instead of yielding a half-initialised module.
const sdkClient = (): Promise<typeof import("./sdk-client")> => (sdkLoading ??= import("./sdk-client"));

async function openProtonDrive(context: BackendRuntimeContext, clientUid: ClientUid): Promise<ProtonConnection> {
	return (await sdkClient()).openProtonDrive(context, clientUid);
}

async function releaseProtonDrive(context: BackendRuntimeContext): Promise<void> {
	await (await sdkClient()).releaseProtonDrive(context);
}

function clientUidOf(config: Readonly<JsonObject>): ClientUid {
	return (asString(config.clientUid) || `air-sync-${crypto.randomUUID()}`) as ClientUid;
}

function configuredFolderPath(config: Readonly<JsonObject>): string {
	return asString(config[APP_ROOT_FOLDER_PATH_KEY]).trim();
}

const auth: BackendAuth = {
	credentialKeys: [SESSION_SECRET_KEY],
	completion: "poll",
	start: async (context) => {
		const fork = await beginFork(new ProtonTransport(context.http, null), context.secrets, Date.now());
		await context.auth.openExternal(fork.signInUrl);
		return { set: { pendingAuthState: String(fork.expiresAtMs) } };
	},
	complete: async (context, _input, config) => {
		const session = await completeFork(new ProtonTransport(context.http, null), context.secrets, {
			now: () => Date.now(),
			sleep,
		});
		// Register a local key for the new session and keep only the sealed key password.
		const handle = SessionHandle.forSignIn(context.secrets, session);
		const signInTransport = new ProtonTransport(context.http, handle);
		let atRest;
		try {
			atRest = await sealKeyPassword(signInTransport, session.uid, session.keyPassword, scrubbingLogger(context.logger));
		} catch (err) {
			// The fork is already consumed: revoke the new session rather than leave a live
			// one nobody holds, store nothing, and ask for a fresh sign-in.
			await signInTransport.json("DELETE", "auth/v4").catch(() => undefined);
			scrubbingLogger(context.logger).warn("Proton Drive sign-in could not be completed securely", { message: errorMessage(err) });
			failBackend("auth", "Proton Drive sign-in could not be completed securely. Click Connect again.");
		}
		await saveSession(context.secrets, { ...handle.tokens, ...atRest });
		const clientUid = clientUidOf(config);
		const folderPath = configuredFolderPath(config);
		const set: JsonObject = { clientUid };
		if (folderPath) {
			// A folder failure leaves the vault unbound; the signed-in session stays.
			try {
				const { drive } = await openProtonDrive(context, clientUid);
				set.remoteVaultFolderId = (await findOrCreateFolderPath(drive, parseFolderPath(folderPath))).uid;
			} catch (err) {
				// The folder path is the user's own folder structure: never logged.
				scrubbingLogger(context.logger).error("Signed in, but the configured Proton Drive folder could not be bound", {
					message: errorMessage(err),
				});
			}
		}
		return { set, unset: ["pendingAuthState"] };
	},
	revoke: async (context) => {
		try {
			// Revoke by the stored tokens alone, so a session in a shape this version no longer
			// opens (e.g. stored before sealing) is still revoked at Proton.
			const tokens = await loadSessionTokens(context.secrets);
			if (tokens) await new ProtonTransport(context.http, SessionHandle.forSignIn(context.secrets, tokens)).json("DELETE", "auth/v4");
		} finally {
			// Whatever the provider answered: no decrypted key and no half-finished sign-in
			// survives a disconnect. Keys first, so a failing secret delete cannot keep them.
			try {
				await releaseProtonDrive(context);
			} finally {
				await context.secrets.delete(FORK_SECRET_KEY);
			}
		}
	},
};

const binding: BackendBinding = {
	resolveDefault: async (context, config, vaultName): Promise<BindingResult> => {
		const existing = asString(config.remoteVaultFolderId);
		if (existing) return { patch: {}, target: { id: existing } };
		const configured = configuredFolderPath(config);
		const name = vaultName.trim();
		if (!configured && !name) {
			failBackend("permanent", "Cannot resolve the Proton Drive remote vault: the vault name is empty.");
		}
		const path = parseFolderPath(configured || `${REMOTE_VAULT_ROOT}/${name}`);
		const { drive } = await openProtonDrive(context, clientUidOf(config));
		const vault = await findOrCreateFolderPath(drive, path);
		return {
			patch: { set: { remoteVaultFolderId: vault.uid } },
			target: { id: vault.uid },
		};
	},
	listAppRootFolders: async (context, config) =>
		listMyFilesFolders((await openProtonDrive(context, clientUidOf(config))).drive),
	appRoot: {
		name: "My files",
		defaultFolderPath: (vaultName) => `${REMOTE_VAULT_ROOT}/${vaultName}`,
	},
	getDisplayPath: async (context, config, target) => {
		const { drive } = await openProtonDrive(context, clientUidOf(config));
		const names: string[] = [];
		let uid: NodeUid | undefined = target.id as NodeUid;
		while (uid !== undefined) {
			const node: DriveNode | undefined = (await drive.getNodes([uid])).get(uid);
			if (!node) return null;
			// The volume root's own name is not part of the path Proton shows.
			if (node.parentUid !== undefined) names.unshift(node.name ?? "?");
			uid = node.parentUid;
		}
		return { id: target.id, displayPath: `/${names.join("/")}` };
	},
};

/** Proton Drive over the official Proton Drive SDK. Unofficial: not affiliated with Proton AG. */
export const protonDriveModule: BackendModule = {
	id: "protondrive",
	displayName: "Proton Drive",
	version: PROTON_MODULE_VERSION,
	apiVersion: BACKEND_MODULE_API_VERSION,
	auth,
	binding,
	getTarget: resolveFolderTarget,
	disconnectConfig: (config): JsonObject => {
		const folderPath = configuredFolderPath(config);
		return folderPath ? { [APP_ROOT_FOLDER_PATH_KEY]: folderPath } : {};
	},
	createAdapter: async (context, config, target): Promise<RemoteBackendAdapter> =>
		new ProtonDriveAdapter((await openProtonDrive(context, clientUidOf(config))).drive, target.id as NodeUid),
};
