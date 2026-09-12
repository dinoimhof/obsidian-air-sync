// SPDX-License-Identifier: GPL-3.0-or-later
// This file bundles @protontech/crypto (GPL-3.0) into the distributed main.js; see
// docs/protondrive-backend.md for the licensing rationale. The rest of this project
// (see LICENSE) remains MIT and is unaffected.

import * as srpRuntime from "@protontech/crypto/srp";

const runtimeValue: unknown = srpRuntime;

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

function call(name: string, args: unknown[]): unknown {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("@protontech/crypto/srp runtime module is unavailable");
	}
	const candidate: unknown = (runtimeValue as Record<string, unknown>)[name];
	if (!isCallable(candidate)) throw new Error(`@protontech/crypto/srp ${name} is unavailable`);
	return candidate(...args);
}

/**
 * Required by `ProtonDriveClient`'s constructor (`srpModule`) even though this
 * backend's session-fork login never invokes direct-password SRP — see
 * docs/protondrive-backend.md's "SRP is not needed for v1" note. Wired with the real
 * implementation regardless, in case the SDK ever calls it internally for an
 * operation this backend doesn't yet exercise.
 */
export async function srpGetSrp(
	version: number,
	modulus: string,
	serverEphemeral: string,
	salt: string,
	password: string,
): Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }> {
	const result = await call("getSrp", [
		{ Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt },
		{ password },
	]);
	if (
		typeof result !== "object" || result === null
		|| typeof (result as Record<string, unknown>).expectedServerProof !== "string"
		|| typeof (result as Record<string, unknown>).clientProof !== "string"
		|| typeof (result as Record<string, unknown>).clientEphemeral !== "string"
	) {
		throw new Error("@protontech/crypto/srp getSrp returned an unexpected shape");
	}
	return result as { expectedServerProof: string; clientProof: string; clientEphemeral: string };
}

export async function srpGetRandomVerifier(
	modulus: string,
	password: string,
): Promise<{ version: number; salt: string; verifier: string }> {
	const result = await call("getRandomSrpVerifier", [{ Modulus: modulus }, { password }]);
	if (
		typeof result !== "object" || result === null
		|| typeof (result as Record<string, unknown>).version !== "number"
		|| typeof (result as Record<string, unknown>).salt !== "string"
		|| typeof (result as Record<string, unknown>).verifier !== "string"
	) {
		throw new Error("@protontech/crypto/srp getRandomSrpVerifier returned an unexpected shape");
	}
	return result as { version: number; salt: string; verifier: string };
}

export async function srpComputeKeyPassword(password: string, salt: string): Promise<string> {
	const result = await call("computeKeyPassword", [password, salt]);
	if (typeof result !== "string") throw new Error("@protontech/crypto/srp computeKeyPassword returned a non-string");
	return result;
}

export function srpGenerateKeySalt(): string {
	const result = call("generateKeySalt", []);
	if (typeof result !== "string") throw new Error("@protontech/crypto/srp generateKeySalt returned a non-string");
	return result;
}
