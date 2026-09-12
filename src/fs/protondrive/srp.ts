// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend, which bundles @protontech/crypto
// (GPL-3.0) into the distributed main.js; see docs/protondrive-backend.md for the
// licensing rationale. The rest of this project (see LICENSE) remains MIT.

import { srpComputeKeyPassword, srpGenerateKeySalt, srpGetRandomVerifier, srpGetSrp } from "../../platform/protondrive-srp";
import type { ProtonAccountApi } from "./account-api";

/**
 * Required by `ProtonDriveClient`'s constructor (`srpModule`) even though this
 * backend's session-fork login never invokes direct-password SRP — see
 * docs/protondrive-backend.md's "SRP is not needed for v1" note. Wired with the real
 * implementation regardless, in case the SDK ever calls it internally for an
 * operation this backend doesn't yet exercise.
 */
export class ProtonSrp {
	constructor(private readonly accountApi: ProtonAccountApi) {}

	async getSrp(version: number, modulus: string, serverEphemeral: string, salt: string, password: string) {
		return srpGetSrp(version, modulus, serverEphemeral, salt, password);
	}

	async getSrpVerifier(password: string) {
		const result = await this.accountApi.modulus();
		if (!result.Modulus || !result.ModulusID) throw new Error("Proton Drive: SRP modulus response is incomplete");
		const { version, salt, verifier } = await srpGetRandomVerifier(result.Modulus, password);
		return { modulusId: result.ModulusID, version, salt, verifier };
	}

	async computeKeyPassword(password: string, salt: string): Promise<string> {
		return srpComputeKeyPassword(password, salt);
	}

	generateKeySalt(): string {
		return srpGenerateKeySalt();
	}
}
