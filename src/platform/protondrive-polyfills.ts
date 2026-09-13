// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of the Proton Drive backend, which bundles @protontech/crypto
// (GPL-3.0) into the distributed main.js; see docs/protondrive-backend.md for the
// licensing rationale. The rest of this project (see LICENSE) remains MIT.

/**
 * @protontech/crypto's dependencies (`@noble/hashes`) prefer the native
 * `Uint8Array.prototype.toHex`/`toBase64` and `Uint8Array.fromHex`/`fromBase64`
 * methods (a recent TC39 proposal) when they appear present, falling back to a
 * manual implementation only when a plain `typeof x === "function"` check
 * fails — see `@noble/hashes`' own `hasHexBuiltin` check. Observed live: inside
 * Obsidian's bundled Electron/V8, that check reports the hex built-ins as
 * present while `Uint8Array.prototype.toHex` is not actually callable — a
 * partial, inconsistent rollout of the proposal that defeats shallow
 * feature-detection and crashes with "(intermediate value).toHex is not a
 * function" on the very first Drive SDK call that names a node (folder
 * listing, node lookups — see docs/protondrive-backend.md). This module
 * verifies each method by actually CALLING it against a known input, not
 * merely checking its type, and (re)defines only the ones that are missing or
 * behave incorrectly — a fully-working native implementation is never
 * touched, and there is no case where both a native and a polyfilled method
 * coexist inconsistently.
 */

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new SyntaxError("Uint8Array.fromHex: odd-length hex string");
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) throw new SyntaxError(`Uint8Array.fromHex: invalid hex at offset ${i * 2}`);
		bytes[i] = byte;
	}
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** A Uint8Array method looked up loosely, since the point of this module is that it may not exist. */
type MaybeMethod<T> = T | undefined;

function worksToHex(): boolean {
	try {
		const candidate = (Uint8Array.prototype as { toHex?: MaybeMethod<() => string> }).toHex;
		return typeof candidate === "function" && candidate.call(new Uint8Array([0xca, 0xfe])) === "cafe";
	} catch {
		return false;
	}
}

function worksFromHex(): boolean {
	try {
		const candidate = (Uint8Array as unknown as { fromHex?: MaybeMethod<(hex: string) => Uint8Array> }).fromHex;
		if (typeof candidate !== "function") return false;
		const result = candidate("cafe");
		return result.length === 2 && result[0] === 0xca && result[1] === 0xfe;
	} catch {
		return false;
	}
}

function worksToBase64(): boolean {
	try {
		const candidate = (Uint8Array.prototype as { toBase64?: MaybeMethod<() => string> }).toBase64;
		return typeof candidate === "function" && candidate.call(new Uint8Array([1, 2, 3])) === bytesToBase64(new Uint8Array([1, 2, 3]));
	} catch {
		return false;
	}
}

function worksFromBase64(): boolean {
	try {
		const candidate = (Uint8Array as unknown as { fromBase64?: MaybeMethod<(b64: string) => Uint8Array> }).fromBase64;
		if (typeof candidate !== "function") return false;
		const result = candidate("AQID");
		return result.length === 3 && result[0] === 1 && result[1] === 2 && result[2] === 3;
	} catch {
		return false;
	}
}

let installed = false;

/**
 * Idempotent. Must run before any Proton Drive SDK/crypto code executes —
 * called from `initProtonDriveCrypto()`, itself required to run first.
 */
export function installUint8ArrayHexBase64Polyfills(): void {
	if (installed) return;
	installed = true;

	if (!worksToHex()) {
		Object.defineProperty(Uint8Array.prototype, "toHex", {
			value(this: Uint8Array) { return bytesToHex(this); },
			writable: true, configurable: true,
		});
	}
	if (!worksFromHex()) {
		Object.defineProperty(Uint8Array, "fromHex", {
			value: hexToBytes,
			writable: true, configurable: true,
		});
	}
	if (!worksToBase64()) {
		Object.defineProperty(Uint8Array.prototype, "toBase64", {
			value(this: Uint8Array) { return bytesToBase64(this); },
			writable: true, configurable: true,
		});
	}
	if (!worksFromBase64()) {
		Object.defineProperty(Uint8Array, "fromBase64", {
			value: base64ToBytes,
			writable: true, configurable: true,
		});
	}
}
