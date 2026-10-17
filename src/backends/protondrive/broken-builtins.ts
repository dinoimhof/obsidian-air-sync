/**
 * Removes Uint8Array hex/base64 built-ins that exist but do not work, so that the core-js
 * polyfills imported right after this module install spec-complete ones.
 *
 * core-js replaces a misbehaving `toHex`/`toBase64` itself, but it keeps any `fromHex` that is
 * present and a `fromBase64` that passes its two edge-case probes, even if both throw on every
 * input. Live testing saw a partial Electron rollout (`toHex` present but not callable), so
 * every method is probed by calling it on a known value. A working native method is left as
 * it is.
 */

type Codec = "toHex" | "toBase64" | "fromHex" | "fromBase64";

interface CodecHost {
	readonly prototype: object;
}

const PROBES: ReadonlyArray<readonly [Codec, "prototype" | "static", (ctor: CodecHost) => boolean]> = [
	["toHex", "prototype", (ctor) => call<string>(Reflect.get(ctor.prototype, "toHex"), bytes(ctor, [0xca, 0xfe])) === "cafe"],
	["toBase64", "prototype", (ctor) => call<string>(Reflect.get(ctor.prototype, "toBase64"), bytes(ctor, [1, 2, 3])) === "AQID"],
	["fromHex", "static", (ctor) => sameBytes(call(Reflect.get(ctor, "fromHex"), ctor, "cafe"), [0xca, 0xfe])],
	["fromBase64", "static", (ctor) => sameBytes(call(Reflect.get(ctor, "fromBase64"), ctor, "AQID"), [1, 2, 3])],
];

function bytes(ctor: CodecHost, values: number[]): unknown {
	return new (ctor as unknown as new (values: number[]) => unknown)(values);
}

function call<T>(method: unknown, self: unknown, ...args: unknown[]): T | undefined {
	return typeof method === "function" ? (Reflect.apply(method, self, args) as T) : undefined;
}

function sameBytes(result: unknown, expected: number[]): boolean {
	return result instanceof Object && Reflect.get(result, "length") === expected.length &&
		expected.every((value, i) => Reflect.get(result, i) === value);
}

/** Deletes each present-but-broken codec on `ctor`; returns the names it removed. */
export function removeBrokenUint8ArrayCodecs(ctor: CodecHost = Uint8Array): Codec[] {
	const removed: Codec[] = [];
	for (const [name, where, works] of PROBES) {
		const owner = where === "prototype" ? ctor.prototype : ctor;
		if (!Object.prototype.hasOwnProperty.call(owner, name)) continue;
		let ok = false;
		try {
			ok = works(ctor);
		} catch {
			ok = false;
		}
		if (!ok && Reflect.deleteProperty(owner, name)) removed.push(name);
	}
	return removed;
}

removeBrokenUint8ArrayCodecs();
