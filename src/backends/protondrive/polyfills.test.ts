import { describe, expect, it } from "vitest";
import { removeBrokenUint8ArrayCodecs } from "./broken-builtins";

/** A stand-in for Uint8Array whose codecs are installed per test. */
function host(codecs: { toHex?: unknown; toBase64?: unknown; fromHex?: unknown; fromBase64?: unknown }) {
	class Bytes extends Uint8Array {}
	const define = (owner: object, name: string, value: unknown) =>
		value !== undefined && Object.defineProperty(owner, name, { value, configurable: true, writable: true });
	define(Bytes.prototype, "toHex", codecs.toHex);
	define(Bytes.prototype, "toBase64", codecs.toBase64);
	define(Bytes, "fromHex", codecs.fromHex);
	define(Bytes, "fromBase64", codecs.fromBase64);
	return Bytes;
}

const notCallable = () => {
	throw new TypeError("(intermediate value).toHex is not a function");
};
const toHex = function (this: Uint8Array) {
	return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
};
const toBase64 = function (this: Uint8Array) {
	return btoa(String.fromCharCode(...this));
};
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("Proton Drive polyfills: broken built-in removal", () => {
	it("removes every hex/base64 codec that exists but throws (the partial Electron rollout)", () => {
		const Bytes = host({ toHex: notCallable, toBase64: notCallable, fromHex: notCallable, fromBase64: notCallable });
		expect(removeBrokenUint8ArrayCodecs(Bytes).sort()).toEqual(["fromBase64", "fromHex", "toBase64", "toHex"]);
		expect(Object.prototype.hasOwnProperty.call(Bytes, "fromHex")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(Bytes.prototype, "toHex")).toBe(false);
	});

	it("removes codecs that answer wrongly, the ones core-js itself would keep", () => {
		const Bytes = host({ fromHex: () => new Uint8Array([9]), fromBase64: () => new Uint8Array(), toHex, toBase64 });
		expect(removeBrokenUint8ArrayCodecs(Bytes).sort()).toEqual(["fromBase64", "fromHex"]);
	});

	it("keeps working codecs untouched, and ignores absent ones", () => {
		const Bytes = host({ toHex, toBase64, fromHex, fromBase64 });
		expect(removeBrokenUint8ArrayCodecs(Bytes)).toEqual([]);
		expect(removeBrokenUint8ArrayCodecs(host({}))).toEqual([]);
	});
});
