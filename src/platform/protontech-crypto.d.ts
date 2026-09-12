// Ambient type stub for @protontech/crypto, redirected here via tsconfig.json's
// "paths": the real package ships raw TypeScript source as its only declarations,
// with no compiled .d.ts boundary, so `tsc -noEmit` would otherwise fully type-check
// Proton's own internal source and fail on pre-existing issues in their code
// (unrelated `.ts`-extension imports requiring `allowImportingTsExtensions`, and
// Uint8Array.prototype.toHex needing a newer `lib` than this project targets).
// Covers only the identifiers actually referenced, directly or transitively (via
// @protontech/drive-sdk's own .d.ts), from this project's type graph — extend it if
// a later step needs more of the real surface.
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

	export interface CryptoApiInterface {
		[member: string]: unknown;
	}

	export enum VERIFICATION_STATUS {
		NOT_SIGNED = 0,
		SIGNED_AND_VALID = 1,
		SIGNED_AND_INVALID = 2,
	}
}
