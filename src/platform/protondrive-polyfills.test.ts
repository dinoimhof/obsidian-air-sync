import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * These tests mutate the REAL global `Uint8Array`/`Uint8Array.prototype` (that's the
 * whole point of the module under test), so every property touched is captured before
 * and restored after each test — a leaked polyfill or stub would otherwise silently
 * affect unrelated tests sharing this vitest worker.
 *
 * This repo's `lib` target predates the hex/base64 proposal, so these methods don't
 * exist on TypeScript's own `Uint8Array`/`Uint8ArrayConstructor` types yet — every
 * access below goes through this one local, explicitly-typed view instead of `any`.
 */
interface HexBase64Bytes extends Uint8Array {
	toHex(): string;
	toBase64(): string;
}
interface HexBase64BytesConstructor {
	fromHex(hex: string): Uint8Array;
	fromBase64(b64: string): Uint8Array;
}
const U8 = Uint8Array as unknown as HexBase64BytesConstructor;
function bytes(values: number[]): HexBase64Bytes {
	return new Uint8Array(values) as HexBase64Bytes;
}

function snapshot(): Record<string, PropertyDescriptor | undefined> {
	return {
		toHex: Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toHex"),
		fromHex: Object.getOwnPropertyDescriptor(Uint8Array, "fromHex"),
		toBase64: Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64"),
		fromBase64: Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64"),
	};
}

function restore(saved: Record<string, PropertyDescriptor | undefined>): void {
	for (const [target, prop] of [
		[Uint8Array.prototype, "toHex"],
		[Uint8Array, "fromHex"],
		[Uint8Array.prototype, "toBase64"],
		[Uint8Array, "fromBase64"],
	] as const) {
		const desc = saved[prop];
		if (desc) Object.defineProperty(target, prop, desc);
		else delete (target as unknown as Record<string, unknown>)[prop];
	}
}

describe("installUint8ArrayHexBase64Polyfills", () => {
	let saved: Record<string, PropertyDescriptor | undefined>;

	beforeEach(() => {
		saved = snapshot();
		vi.resetModules();
	});

	afterEach(() => {
		restore(saved);
	});

	it("installs working toHex/fromHex/toBase64/fromBase64 when none exist", async () => {
		const { installUint8ArrayHexBase64Polyfills } = await import("./protondrive-polyfills");
		installUint8ArrayHexBase64Polyfills();

		expect(bytes([0xca, 0xfe]).toHex()).toBe("cafe");
		expect([...U8.fromHex("cafe")]).toEqual([0xca, 0xfe]);
		expect(bytes([1, 2, 3]).toBase64()).toBe(btoa(String.fromCharCode(1, 2, 3)));
		expect([...U8.fromBase64(btoa(String.fromCharCode(1, 2, 3)))]).toEqual([1, 2, 3]);
	});

	it("replaces a present-but-broken toHex (the reported live failure) while leaving a genuinely working sibling alone", async () => {
		// Reproduces the exact reported asymmetry: something makes toHex LOOK present
		// but throw when called, while fromHex already works correctly.
		Object.defineProperty(Uint8Array.prototype, "toHex", {
			value() { throw new TypeError("toHex is not a function"); },
			configurable: true,
		});
		const workingFromHex = vi.fn((hex: string) => {
			const result = new Uint8Array(hex.length / 2);
			for (let i = 0; i < result.length; i++) result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
			return result;
		});
		Object.defineProperty(Uint8Array, "fromHex", { value: workingFromHex, configurable: true });

		const { installUint8ArrayHexBase64Polyfills } = await import("./protondrive-polyfills");
		installUint8ArrayHexBase64Polyfills();

		// Broken → replaced with a working implementation.
		expect(bytes([0xca, 0xfe]).toHex()).toBe("cafe");
		// Already worked → left untouched (the same function object, not just equivalent behavior).
		expect(Object.getOwnPropertyDescriptor(Uint8Array, "fromHex")?.value).toBe(workingFromHex);
	});

	it("is idempotent", async () => {
		const { installUint8ArrayHexBase64Polyfills } = await import("./protondrive-polyfills");
		installUint8ArrayHexBase64Polyfills();
		installUint8ArrayHexBase64Polyfills();

		expect(bytes([0xca, 0xfe]).toHex()).toBe("cafe");
	});

	it("fromHex rejects an odd-length or non-hex string", async () => {
		const { installUint8ArrayHexBase64Polyfills } = await import("./protondrive-polyfills");
		installUint8ArrayHexBase64Polyfills();

		expect(() => U8.fromHex("abc")).toThrow(SyntaxError);
		expect(() => U8.fromHex("zz")).toThrow(SyntaxError);
	});
});
