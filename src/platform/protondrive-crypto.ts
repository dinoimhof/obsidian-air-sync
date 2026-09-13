// SPDX-License-Identifier: GPL-3.0-or-later
// This file bundles @protontech/crypto (GPL-3.0) into the distributed main.js; see
// docs/protondrive-backend.md for the licensing rationale. The rest of this project
// (see LICENSE) remains MIT and is unaffected.

import * as cryptoRuntime from "@protontech/crypto";
import * as cryptoEndpointRuntime from "@protontech/crypto/proxy/endpoint/api.ts";
import { installUint8ArrayHexBase64Polyfills } from "./protondrive-polyfills";

const runtimeValue: unknown = cryptoRuntime;
const endpointRuntimeValue: unknown = cryptoEndpointRuntime;

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

interface EndpointCtor {
	new (): { clearKeyStore(): void };
	init(options: Record<string, unknown>): void;
}

function endpointConstructor(): EndpointCtor {
	if (typeof endpointRuntimeValue !== "object" || endpointRuntimeValue === null) {
		throw new Error("@protontech/crypto/proxy/endpoint/api.ts runtime module is unavailable");
	}
	const candidate: unknown = (endpointRuntimeValue as Record<string, unknown>).Api;
	if (!isCallable(candidate)) throw new Error("@protontech/crypto/proxy/endpoint/api.ts Api export is unavailable");
	// isCallable only proves it's invocable; a constructor is additionally validated by
	// actually constructing+initializing it in initProtonDriveCrypto below, which throws
	// immediately (rather than later, obscurely) if the shape is ever wrong.
	return candidate as unknown as EndpointCtor;
}

function proxyMember(name: string): unknown {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("@protontech/crypto runtime module is unavailable");
	}
	const proxy: unknown = (runtimeValue as Record<string, unknown>).CryptoProxy;
	if (typeof proxy !== "object" || proxy === null) throw new Error("@protontech/crypto CryptoProxy is unavailable");
	return (proxy as Record<string, unknown>)[name];
}

function callProxy(name: string, args: unknown[]): Promise<unknown> {
	const candidate = proxyMember(name);
	if (!isCallable(candidate)) throw new Error(`@protontech/crypto CryptoProxy.${name} is unavailable`);
	return Promise.resolve(candidate(...args));
}

let initialized = false;

/**
 * Install the concrete, WASM/worker-backed crypto endpoint behind `CryptoProxy` (the
 * SDK's abstract entry point). Idempotent and must be called before any other
 * function in this module — mirrors the reference implementation this backend's live
 * spike verified working (see docs/protondrive-backend.md). Also installs the
 * `Uint8Array` hex/base64 polyfills (see protondrive-polyfills.ts) first — this
 * module's dependencies assume those exist and work, which is not reliably true
 * across every Electron/V8 build Obsidian ships on.
 */
export function initProtonDriveCrypto(): void {
	if (initialized) return;
	installUint8ArrayHexBase64Polyfills();
	const Endpoint = endpointConstructor();
	Endpoint.init({});
	const setEndpoint = proxyMember("setEndpoint");
	if (!isCallable(setEndpoint)) throw new Error("@protontech/crypto CryptoProxy.setEndpoint is unavailable");
	const endpoint = new Endpoint();
	setEndpoint(endpoint, (e: { clearKeyStore: () => void }) => { e.clearKeyStore(); });
	initialized = true;
}

/** An opaque, session-lifetime key handle. Never introspected — only ever passed back
 * into these same functions. */
export type ProtonKeyHandle = unknown;

/**
 * The validated `CryptoProxy` facade itself, for the one legitimate case something
 * outside this file needs it directly: constructing the SDK's
 * `OpenPGPCryptoWithCryptoProxy` (see platform/protondrive.ts), which the verified
 * reference implementation always builds from this exact object (see
 * docs/protondrive-backend.md). Kept `unknown` at this boundary too — the caller casts
 * it, once, into whatever the SDK's own constructor needs.
 */
export function getRawCryptoProxyForSdk(): unknown {
	if (typeof runtimeValue !== "object" || runtimeValue === null) {
		throw new Error("@protontech/crypto runtime module is unavailable");
	}
	const proxy: unknown = (runtimeValue as Record<string, unknown>).CryptoProxy;
	if (typeof proxy !== "object" || proxy === null) throw new Error("@protontech/crypto CryptoProxy is unavailable");
	return proxy;
}

export async function cryptoImportPrivateKey(armoredKey: string, passphrase: string): Promise<ProtonKeyHandle> {
	return callProxy("importPrivateKey", [{ armoredKey, passphrase }]);
}

export async function cryptoImportPublicKeyArmored(armoredKey: string): Promise<ProtonKeyHandle> {
	return callProxy("importPublicKey", [{ armoredKey }]);
}

export async function cryptoImportPublicKeyBinary(binaryKey: Uint8Array): Promise<ProtonKeyHandle> {
	return callProxy("importPublicKey", [{ binaryKey }]);
}

export async function cryptoExportPublicKeyBinary(key: ProtonKeyHandle): Promise<Uint8Array> {
	const result = await callProxy("exportPublicKey", [{ key, format: "binary" }]);
	if (!(result instanceof Uint8Array)) throw new Error("@protontech/crypto exportPublicKey returned an unexpected shape");
	return result;
}

/**
 * Decrypt an armored, detachedly-signed message and report only whether the
 * signature verified — the raw `VERIFICATION_STATUS` enum never needs to leave this
 * boundary (see addresses.ts, the sole caller).
 */
export async function cryptoDecryptAndVerify(
	armoredMessage: string,
	armoredSignature: string,
	decryptionKeys: ProtonKeyHandle[],
	verificationKeys: ProtonKeyHandle[],
): Promise<{ data: string; verified: boolean }> {
	const result = await callProxy("decryptMessage", [
		{ armoredMessage, armoredSignature, decryptionKeys, verificationKeys },
	]);
	if (typeof result !== "object" || result === null) {
		throw new Error("@protontech/crypto decryptMessage returned an unexpected shape");
	}
	const { data, verificationStatus } = result as Record<string, unknown>;
	if (typeof data !== "string") throw new Error("@protontech/crypto decryptMessage returned non-string data");
	// SIGNED_AND_VALID's real numeric value (see @protontech/crypto's pmcrypto/constants.ts,
	// confirmed live in this backend's spike — see docs/protondrive-backend.md).
	return { data, verified: verificationStatus === 1 };
}
