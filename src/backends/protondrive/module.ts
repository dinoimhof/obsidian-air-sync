import type {
	BackendAuth,
	BackendBinding,
	BackendModule,
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
import type { ClientUid } from "./sdk-client";
import { openProtonDrive, releaseProtonDrive } from "./sdk-client";
import { SESSION_SECRET_KEY, SessionHandle, saveSession } from "./session";
import { ProtonTransport } from "./transport";
import { scrubbingLogger } from "./redact";

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
		await saveSession(context.secrets, session);
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
			const session = await SessionHandle.open(context.secrets).catch(() => null);
			if (session) await new ProtonTransport(context.http, session).json("DELETE", "auth/v4");
		} finally {
			// Whatever the provider answered: no half-finished sign-in and no decrypted key
			// survives a disconnect.
			await context.secrets.delete(FORK_SECRET_KEY);
			await releaseProtonDrive();
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
