import { ProtonApiClient, isOkResponse } from "./api-client";
import { PROTON_DRIVE_AUTH } from "../auth-config";

export interface ProtonAddressKey {
	ID?: string;
	PrivateKey?: string;
	Token?: string;
	Signature?: string;
}

export interface ProtonAddress {
	ID?: string;
	Email?: string;
	Keys?: ProtonAddressKey[];
}

interface ProtonUsersResponse {
	User?: { Keys?: Array<{ PrivateKey?: string }> };
}

interface ProtonAddressesResponse {
	Addresses?: ProtonAddress[];
}

interface ProtonKeysResponse {
	Address?: { Keys?: Array<{ PublicKey?: string }> };
}

interface ProtonModulusResponse {
	Modulus?: string;
	ModulusID?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The handful of Proton core-API endpoints this backend's key-decryption and (unused
 * but SDK-required, see docs/protondrive-backend.md) SRP wiring need. Every call is
 * authenticated — none of these are reachable before a session-fork login completes.
 */
export class ProtonAccountApi {
	constructor(private readonly api: ProtonApiClient) {}

	/** The logged-in user's own primary (account-level) keys. */
	async users(): Promise<ProtonUsersResponse> {
		const res = await this.api.authenticatedRequest(`${PROTON_DRIVE_AUTH.apiBaseUrl}/core/v4/users`);
		if (!isOkResponse(res)) throw new Error(`Proton Drive: fetching user keys failed (${res.status})`);
		if (!isRecord(res.json)) throw new Error("Proton Drive: invalid users response");
		return res.json;
	}

	/** The logged-in user's own email addresses, each with its own address keys. */
	async addresses(): Promise<ProtonAddressesResponse> {
		const res = await this.api.authenticatedRequest(`${PROTON_DRIVE_AUTH.apiBaseUrl}/core/v4/addresses`, {
			searchParams: { Page: 0, PageSize: 50 },
		});
		if (!isOkResponse(res)) throw new Error(`Proton Drive: fetching addresses failed (${res.status})`);
		if (!isRecord(res.json)) throw new Error("Proton Drive: invalid addresses response");
		return res.json;
	}

	/** Another Proton user's public keys (for sharing — this backend doesn't call it yet). */
	async keys(email: string): Promise<ProtonKeysResponse> {
		const res = await this.api.authenticatedRequest(`${PROTON_DRIVE_AUTH.apiBaseUrl}/core/v4/keys/all`, {
			searchParams: { Email: email, InternalOnly: 1 },
		});
		// Deliberately does not echo `email` — it can be a THIRD PARTY's address (a
		// sharing lookup), and this message can end up in .airsync/logs/ (see Logger).
		if (!isOkResponse(res)) throw new Error(`Proton Drive: fetching keys for an address failed (${res.status})`);
		if (!isRecord(res.json)) throw new Error("Proton Drive: invalid keys response");
		return res.json;
	}

	/** SRP modulus — only reachable via the (unused, SDK-required) Srp wrapper. */
	async modulus(): Promise<ProtonModulusResponse> {
		const res = await this.api.authenticatedRequest(`${PROTON_DRIVE_AUTH.apiBaseUrl}/core/v4/auth/modulus`);
		if (!isOkResponse(res)) throw new Error(`Proton Drive: fetching modulus failed (${res.status})`);
		if (!isRecord(res.json)) throw new Error("Proton Drive: invalid modulus response");
		return res.json;
	}
}
