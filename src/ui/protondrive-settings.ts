// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { App } from "../platform/obsidian";
import { Setting } from "../platform/obsidian";
import type { AirSyncSettings } from "../settings";
import type { BackendConnectionActions, IBackendSettingsRenderer } from "../fs/settings-renderer";
import type { ProtonDriveBackendData, ProtonDriveProvider } from "../fs/protondrive/provider";
import { PROTON_DRIVE_BACKEND_TYPE } from "../fs/protondrive/auth";
import { getBackendProvider } from "../fs/registry";
import { renderBoundFolderField, renderConnectionStatus } from "./backend-settings-ui";
import { ProtonDriveFolderPickerModal } from "./protondrive-folder-picker";

/**
 * Renders Proton Drive-specific settings UI: connection status (session-fork
 * sign-in, opened in the system browser — see docs/protondrive-backend.md), an
 * explicit full-Drive access disclosure, and remote-folder selection.
 *
 * Unlike OneDrive/Dropbox (App-Folder scoped), Proton Drive has no OAuth
 * app-folder scoping: once connected, this backend can see and manage the
 * account's whole Drive, not just its own folder. The folder picker
 * (`ProtonDriveFolderPickerModal`) therefore browses the real Drive tree instead
 * of a fixed app-root listing.
 */
export class ProtonDriveSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = PROTON_DRIVE_BACKEND_TYPE;

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		app: App,
	): void {
		const provider = getBackendProvider(PROTON_DRIVE_BACKEND_TYPE) as ProtonDriveProvider | undefined;
		const authed = provider?.auth.isAuthenticated(settings.backendData ?? {}) ?? false;
		const data = (settings.backendData ?? {}) as Partial<ProtonDriveBackendData>;

		new Setting(containerEl)
			.setName("Full-drive access")
			.setDesc(
				"Proton Drive has no per-app scoping: once connected, Air Sync can see and " +
				"manage this account's whole Drive, not just its own folder. Choose or create " +
				"the folder this vault syncs into below.",
			);

		renderConnectionStatus(containerEl, {
			connected: authed,
			connectLabel: "Connect to Proton Drive",
			actions,
		});

		if (!authed) return;

		const folderSetting = new Setting(containerEl).setName("Remote vault folder");

		if (data.remoteVaultFolderId) {
			renderBoundFolderField(folderSetting, {
				desc: "The folder this vault syncs into.",
				folderId: data.remoteVaultFolderId,
				resolvePath: () => provider?.getRemoteVaultDisplayPath?.(settings),
			});
			return;
		}

		folderSetting.setDesc(
			"Choose where this vault syncs: use the default folder, or browse to an " +
			"existing folder anywhere in Proton Drive.",
		);
		folderSetting
			.addButton((button) =>
				button
					.setButtonText(app.vault.getName())
					.setCta()
					.onClick(() => void actions.bindDefaultFolder()))
			.addButton((button) =>
				button
					.setButtonText("Choose folder")
					.onClick(() => {
						if (!provider) return;
						new ProtonDriveFolderPickerModal(app, provider.createUiClient(settings), async (folderUid) => {
							const result = await provider.bindPickedFolder(folderUid);
							await onSave(result.backendUpdates);
							actions.refreshDisplay();
						}).open();
					}));
	}
}
