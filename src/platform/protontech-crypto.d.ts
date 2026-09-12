// SPDX-License-Identifier: GPL-3.0-or-later
// Kept consistent with the rest of the Proton Drive integration's files even though
// this stub is type-only and ships zero bytes into main.js; see
// docs/protondrive-backend.md for the licensing rationale. The rest of this project
// (see LICENSE) remains MIT and is unaffected.
//
// Ambient type stubs for @protontech/crypto and two of its subpaths, redirected here
// via tsconfig.json's "paths": the real package ships raw TypeScript source as its
// only declarations, with no compiled .d.ts boundary, so `tsc -noEmit` would
// otherwise fully type-check Proton's own internal source and fail on pre-existing
// issues in their code (unrelated `.ts`-extension imports requiring
// `allowImportingTsExtensions`, and Uint8Array.prototype.toHex needing a newer `lib`
// than this project targets). Each block covers only the identifiers actually
// referenced from this project's type graph — extend it if a later step needs more
// of the real surface. Call shapes are pinned to what the Proton Drive backend's
// throwaway spike verified working live against a real account (see
// docs/protondrive-backend.md), not guessed from documentation.
//
// esbuild only honors tsconfig.json's "paths" when "baseUrl" is also set. tsconfig.json
// deliberately has no "baseUrl", so esbuild ignores this redirect and bundles the real
// package normally — never add "baseUrl" there, or esbuild will start bundling this
// type-only stub instead of the real @protontech/crypto implementation.
declare module "@protontech/crypto" {
	export type PrivateKeyReference = unknown;
	export type PrivateKeyReferenceV4 = PrivateKeyReference;
	export type PublicKeyReference = unknown;
	export type SessionKey = unknown;

	export enum VERIFICATION_STATUS {
		NOT_SIGNED = 0,
		SIGNED_AND_VALID = 1,
		SIGNED_AND_INVALID = 2,
	}

	// drive-sdk's own (real, compiled) declarations import THIS exact type name for
	// OpenPGPCryptoWithCryptoProxy's constructor parameter, which the verified-working
	// reference implementation always calls with the CryptoProxy facade object itself
	// (not the narrower concrete endpoint below) — so this must be the facade's own
	// shape, not just whatever setEndpoint's cleanup callback happens to touch.
	export interface CryptoApiInterface {
		importPrivateKey(options: { armoredKey: string; passphrase: string }): Promise<PrivateKeyReference>;
		importPublicKey(options: { armoredKey: string } | { binaryKey: Uint8Array }): Promise<PublicKeyReference>;
		exportPublicKey(options: { key: PrivateKeyReference; format: "binary" }): Promise<Uint8Array>;
		decryptMessage(options: {
			armoredMessage: string;
			armoredSignature: string;
			decryptionKeys: PrivateKeyReference[];
			verificationKeys: PublicKeyReference[];
		}): Promise<{ data: string; verificationStatus: VERIFICATION_STATUS }>;
	}

	export const CryptoProxy: CryptoApiInterface & {
		// setEndpoint's own parameter is a separate, narrower shape (the concrete
		// endpoint class below, not the facade itself) — a generic constrained to just
		// what the cleanup callback needs, so it doesn't have to satisfy
		// CryptoApiInterface too.
		setEndpoint<Endpoint extends { clearKeyStore(): void }>(
			endpoint: Endpoint,
			cleanup?: (endpoint: Endpoint) => void,
		): void;
	};
}

// The concrete, WASM/worker-backed crypto endpoint. Constructed once per plugin
// lifetime and installed via CryptoProxy.setEndpoint (see src/platform/protondrive-crypto.ts).
declare module "@protontech/crypto/proxy/endpoint/api.ts" {
	export class Api {
		constructor();
		static init(options: Record<string, unknown>): void;
		clearKeyStore(): void;
	}
}

// Required by ProtonDriveClient's constructor (srpModule) even though this backend's
// session-fork login never invokes it directly — see docs/protondrive-backend.md's
// "SRP is not needed for v1" note. Wired with the real implementation regardless (not
// a no-op stub), matching the verified-working reference implementation, in case the
// SDK ever calls it internally for an operation this backend doesn't yet exercise.
declare module "@protontech/crypto/srp" {
	export function getSrp(
		params: { Version: number; Modulus: string; ServerEphemeral: string; Salt: string },
		credentials: { password: string },
	): Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }>;
	export function getRandomSrpVerifier(
		params: { Modulus: string },
		credentials: { password: string },
	): Promise<{ version: number; salt: string; verifier: string }>;
	export function computeKeyPassword(password: string, salt: string): Promise<string>;
	export function generateKeySalt(): string;
}
