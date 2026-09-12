import { describe } from "vitest";
import type { RemoteBackendFamily } from "./contracts/remote-backend-family";
import { registerGoogleDriveIFileSystemContract } from "./googledrive/ifilesystem.contract-harness";
import { registerGoogleDriveCachingContract } from "./googledrive/caching-remote-fs.contract-harness";
import { registerGoogleDriveChangeDetectionContract } from "./googledrive/remote-change-detection.contract-harness";
import { registerGoogleDrivePriorityObservationContract } from "./googledrive/priority-observation.contract-harness";
import { registerDropboxIFileSystemContract } from "./dropbox/ifilesystem.contract-harness";
import { registerDropboxCachingContract } from "./dropbox/caching-remote-fs.contract-harness";
import { registerDropboxChangeDetectionContract } from "./dropbox/remote-change-detection.contract-harness";
import { registerDropboxPriorityObservationContract } from "./dropbox/priority-observation.contract-harness";
import { registerOneDriveIFileSystemContract } from "./onedrive/ifilesystem.contract-harness";
import { registerOneDriveCachingContract } from "./onedrive/caching-remote-fs.contract-harness";
import { registerOneDriveChangeDetectionContract } from "./onedrive/remote-change-detection.contract-harness";
import { registerOneDrivePriorityObservationContract } from "./onedrive/priority-observation.contract-harness";
import { registerProtonDriveIFileSystemContract } from "./protondrive/ifilesystem.contract-harness";
import { registerProtonDriveCachingContract } from "./protondrive/caching-remote-fs.contract-harness";
import { registerProtonDriveChangeDetectionContract } from "./protondrive/remote-change-detection.contract-harness";
import { registerProtonDrivePriorityObservationContract } from "./protondrive/priority-observation.contract-harness";

interface RequiredRemoteContractSet {
	filesystem: () => void;
	caching: () => void;
	changeDetection: () => void;
	priorityObservation: () => void;
}

const remoteBackendContracts = {
	googledrive: {
		filesystem: registerGoogleDriveIFileSystemContract,
		caching: registerGoogleDriveCachingContract,
		changeDetection: registerGoogleDriveChangeDetectionContract,
		priorityObservation: registerGoogleDrivePriorityObservationContract,
	},
	dropbox: {
		filesystem: registerDropboxIFileSystemContract,
		caching: registerDropboxCachingContract,
		changeDetection: registerDropboxChangeDetectionContract,
		priorityObservation: registerDropboxPriorityObservationContract,
	},
	onedrive: {
		filesystem: registerOneDriveIFileSystemContract,
		caching: registerOneDriveCachingContract,
		changeDetection: registerOneDriveChangeDetectionContract,
		priorityObservation: registerOneDrivePriorityObservationContract,
	},
	protondrive: {
		filesystem: registerProtonDriveIFileSystemContract,
		caching: registerProtonDriveCachingContract,
		changeDetection: registerProtonDriveChangeDetectionContract,
		priorityObservation: registerProtonDrivePriorityObservationContract,
	},
} satisfies Record<RemoteBackendFamily, RequiredRemoteContractSet>;

for (const [family, contracts] of Object.entries(remoteBackendContracts)) {
	describe(`required remote contracts — ${family}`, () => {
		for (const registerContract of Object.values(contracts)) registerContract();
	});
}
