// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend, which bundles @protontech/crypto
// (GPL-3.0) into the distributed main.js; see docs/protondrive-backend.md for the
// licensing rationale. The rest of this project (see LICENSE) remains MIT.

import type { ProtonDriveAccount, ProtonDriveAccountAddress } from "@protontech/drive-sdk";
import {
	cryptoDecryptAndVerify,
	cryptoExportPublicKeyBinary,
	cryptoImportPrivateKey,
	cryptoImportPublicKeyArmored,
	cryptoImportPublicKeyBinary,
	type ProtonKeyHandle,
} from "../../platform/protondrive-crypto";
import type { ProtonAddress, ProtonAddressKey, ProtonAccountApi } from "./account-api";
import type { ProtonDriveAuth } from "./auth";

interface UserData {
	userPrimaryPrivateKeys: ProtonKeyHandle[];
	userPrimaryPublicKeys: ProtonKeyHandle[];
	addresses: ProtonAddress[];
}

/**
 * Decrypts the account's own private keys with `keyPassword` (from the session-fork
 * login — see docs/protondrive-backend.md) and implements the `ProtonDriveAccount`
 * interface the SDK's `ProtonDriveClient` needs to encrypt/decrypt/verify content.
 * Decrypted keys live only in memory for this session; never persisted (only the
 * session and `keyPassword` are — see auth.ts). Verified working end to end against a
 * live account in this backend's spike (see docs/protondrive-backend.md) before being
 * ported here.
 */
export class ProtonDriveAddresses implements ProtonDriveAccount {
	private userDataPromise?: Promise<UserData>;
	private readonly addressKeyPromises = new Map<
		string,
		Promise<{ id: string; privateKey: ProtonKeyHandle; publicKey: ProtonKeyHandle }>
	>();

	constructor(
		private readonly accountApi: ProtonAccountApi,
		private readonly auth: ProtonDriveAuth,
	) {}

	async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
		const { addresses } = await this.getUserData();
		const primary = addresses[0];
		if (!primary?.ID) throw new Error("Proton Drive: no primary address on this account");
		return this.getOwnAddress(primary.ID);
	}

	async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
		const { addresses } = await this.getUserData();
		const results: ProtonDriveAccountAddress[] = [];
		for (const address of addresses) {
			if (address.ID) results.push(await this.getOwnAddress(address.ID));
		}
		return results;
	}

	async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
		const { userPrimaryPrivateKeys, userPrimaryPublicKeys, addresses } = await this.getUserData();
		const address = addresses.find((a) => a.ID === emailOrAddressId || a.Email === emailOrAddressId);
		// Deliberately does not echo `emailOrAddressId`/the address email into the error
		// message: both can be a real email address, and this message can end up in
		// .airsync/logs/ (see Logger) — an opaque, non-identifying failure is enough to
		// act on ("reconnect"), and the account-holder already knows what they searched for.
		if (!address?.ID || !address.Email) throw new Error("Proton Drive: requested address not found on this account");

		const keys: { id: string; key: ProtonKeyHandle }[] = [];
		for (const key of address.Keys ?? []) {
			const { id, privateKey } = await this.getAddressKey(userPrimaryPrivateKeys, userPrimaryPublicKeys, key);
			keys.push({ id, key: privateKey });
		}
		// address.ID (opaque) instead of address.Email — see the note above.
		if (keys.length === 0) throw new Error(`Proton Drive: no usable key for address ${address.ID}`);
		return { email: address.Email, addressId: address.ID, primaryKeyIndex: 0, keys };
	}

	hasProtonAccount(): Promise<boolean> {
		// Only used for sharing, which this backend doesn't implement yet.
		return Promise.resolve(true);
	}

	async getPublicKeys(email: string): Promise<ProtonKeyHandle[]> {
		const { userPrimaryPrivateKeys, userPrimaryPublicKeys, addresses } = await this.getUserData();
		const ownAddress = addresses.find((a) => a.Email === email);
		if (ownAddress) {
			const keys: ProtonKeyHandle[] = [];
			for (const key of ownAddress.Keys ?? []) {
				const { publicKey } = await this.getAddressKey(userPrimaryPrivateKeys, userPrimaryPublicKeys, key);
				keys.push(publicKey);
			}
			return keys;
		}
		const response = await this.accountApi.keys(email);
		return Promise.all(
			(response.Address?.Keys ?? [])
				.filter((k): k is { PublicKey: string } => !!k.PublicKey)
				.map((k) => cryptoImportPublicKeyArmored(k.PublicKey)),
		);
	}

	private async getUserData(): Promise<UserData> {
		this.userDataPromise ??= this.loadUserData();
		return this.userDataPromise;
	}

	private async loadUserData(): Promise<UserData> {
		const keyPassword = this.auth.getKeyPassword();
		if (!keyPassword) throw new Error("Proton Drive: not logged in (no key password)");

		try {
			const users = await this.accountApi.users();
			const userPrimaryPrivateKeys: ProtonKeyHandle[] = [];
			const userPrimaryPublicKeys: ProtonKeyHandle[] = [];
			for (const userKey of users.User?.Keys ?? []) {
				if (!userKey.PrivateKey) continue;
				const privateKey = await cryptoImportPrivateKey(userKey.PrivateKey, keyPassword);
				const publicKey = await cryptoImportPublicKeyBinary(await cryptoExportPublicKeyBinary(privateKey));
				userPrimaryPrivateKeys.push(privateKey);
				userPrimaryPublicKeys.push(publicKey);
			}
			if (userPrimaryPrivateKeys.length === 0) throw new Error("Proton Drive: no decryptable user keys");

			const addressesRes = await this.accountApi.addresses();
			return { userPrimaryPrivateKeys, userPrimaryPublicKeys, addresses: addressesRes.Addresses ?? [] };
		} catch (err) {
			this.userDataPromise = undefined;
			throw err;
		}
	}

	private async getAddressKey(
		userPrimaryPrivateKeys: ProtonKeyHandle[],
		userPrimaryPublicKeys: ProtonKeyHandle[],
		key: ProtonAddressKey,
	): Promise<{ id: string; privateKey: ProtonKeyHandle; publicKey: ProtonKeyHandle }> {
		const keyId = key.ID;
		if (!keyId) throw new Error("Proton Drive: address key is missing an ID");
		const existing = this.addressKeyPromises.get(keyId);
		if (existing) return existing;

		const promise = this.loadAddressKey(userPrimaryPrivateKeys, userPrimaryPublicKeys, key, keyId);
		this.addressKeyPromises.set(keyId, promise);
		return promise;
	}

	private async loadAddressKey(
		userPrimaryPrivateKeys: ProtonKeyHandle[],
		userPrimaryPublicKeys: ProtonKeyHandle[],
		key: ProtonAddressKey,
		keyId: string,
	): Promise<{ id: string; privateKey: ProtonKeyHandle; publicKey: ProtonKeyHandle }> {
		try {
			const keyPassword = this.auth.getKeyPassword();
			let privateKey: ProtonKeyHandle;
			if (!key.Token && key.PrivateKey) {
				// Legacy (pre-2024) shape: the address key is encrypted directly with the
				// mailbox key password, not a per-key token.
				privateKey = await cryptoImportPrivateKey(key.PrivateKey, keyPassword);
			} else {
				const { data: decryptedToken, verified } = await cryptoDecryptAndVerify(
					key.Token ?? "",
					key.Signature ?? "",
					userPrimaryPrivateKeys,
					userPrimaryPublicKeys,
				);
				if (!verified) throw new Error("signature verification failed for address key token");
				privateKey = await cryptoImportPrivateKey(key.PrivateKey ?? "", decryptedToken);
			}
			const publicKey = await cryptoImportPublicKeyBinary(await cryptoExportPublicKeyBinary(privateKey));
			return { id: keyId, privateKey, publicKey };
		} catch (err) {
			this.addressKeyPromises.delete(keyId);
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`Proton Drive: could not load address key ${keyId}: ${detail}`);
		}
	}
}
