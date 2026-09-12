// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend; see docs/protondrive-backend.md
// for the licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { App } from "../platform/obsidian";
import { Modal, Notice, Setting } from "../platform/obsidian";
import type { AirSyncSettings } from "../settings";

/** A single Drive entry, as needed for browsing — a structural subset of `ProtonDriveNode`. */
export interface ProtonDriveFolderEntry {
	uid: string;
	name: string;
	isFolder: boolean;
}

/** Minimal client shape the picker needs: browse and create folders anywhere in the Drive. */
export interface ProtonDriveFolderBrowseClient {
	getRootFolder(): Promise<ProtonDriveFolderEntry>;
	listChildren(parentUid: string): Promise<ProtonDriveFolderEntry[]>;
	createFolder(parentUid: string, name: string): Promise<ProtonDriveFolderEntry>;
}

/** Minimal provider shape: build a UI client for the given settings. */
export interface ProtonDriveFolderPickerProvider {
	createUiClient(settings: AirSyncSettings): ProtonDriveFolderBrowseClient;
}

/**
 * In-app folder browser for Proton Drive's full-drive scope (there is no app-folder
 * subset to list, unlike `AppFolderPickerModal`'s Dropbox/OneDrive shape) — lets the
 * user drill down from "My files" into an arbitrary existing folder, or create a new
 * one along the way, and bind the vault directly to its uid via `onPick`.
 */
export class ProtonDriveFolderPickerModal extends Modal {
	private readonly path: { uid: string; name: string }[] = [];
	private newName = "";
	private loadError: string | null = null;

	constructor(
		app: App,
		private readonly client: ProtonDriveFolderBrowseClient,
		private readonly onPick: (folderUid: string) => Promise<void>,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.setTitle("Choose a Proton Drive folder");
		try {
			const root = await this.client.getRootFolder();
			this.path.push({ uid: root.uid, name: "My files" });
		} catch (err) {
			this.loadError = err instanceof Error ? err.message : String(err);
		}
		await this.render();
	}

	private get current(): { uid: string; name: string } {
		return this.path[this.path.length - 1]!;
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		if (this.loadError) {
			contentEl.createEl("p", { text: `Could not open Proton Drive: ${this.loadError}` });
			return;
		}

		contentEl.createEl("p", {
			text: `Current folder: ${this.path.map((p) => p.name).join(" / ")}`,
		});

		if (this.path.length > 1) {
			new Setting(contentEl).addButton((button) =>
				button.setButtonText("⬅ Up").onClick(() => void this.goUp()));
		}

		let folders: ProtonDriveFolderEntry[] = [];
		try {
			folders = (await this.client.listChildren(this.current.uid)).filter((entry) => entry.isFolder);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			contentEl.createEl("p", { text: `Could not list folders: ${reason}` });
		}

		for (const folder of folders) {
			new Setting(contentEl)
				.setName(folder.name)
				.addButton((button) => button.setButtonText("Open").onClick(() => void this.descend(folder)));
		}

		new Setting(contentEl)
			.setName("New folder")
			.setDesc("Create a new folder here.")
			.addText((text) =>
				text.setPlaceholder("Folder name").onChange((value) => { this.newName = value.trim(); }))
			.addButton((button) => button.setButtonText("Create").onClick(() => void this.createAndDescend()));

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Use this folder")
				.setCta()
				.onClick(() => void this.confirm()));
	}

	private async descend(folder: ProtonDriveFolderEntry): Promise<void> {
		this.path.push({ uid: folder.uid, name: folder.name });
		await this.render();
	}

	private async goUp(): Promise<void> {
		if (this.path.length > 1) this.path.pop();
		await this.render();
	}

	private async createAndDescend(): Promise<void> {
		if (!this.newName) {
			new Notice("Enter a folder name.");
			return;
		}
		try {
			const folder = await this.client.createFolder(this.current.uid, this.newName);
			this.newName = "";
			await this.descend(folder);
		} catch (err) {
			new Notice(`Could not create folder: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async confirm(): Promise<void> {
		const target = this.current;
		this.close();
		await this.onPick(target.uid);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
