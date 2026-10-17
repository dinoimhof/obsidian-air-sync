/**
 * Guards the Proton Drive polyfills against the failure seen live: Obsidian's Electron
 * exposed `Uint8Array` hex/base64 methods that were present but not callable, and the
 * first SDK call that named a node crashed. Two checks, both on the real code:
 *
 * 1. The production polyfill entry (bundled exactly as esbuild bundles main.js) leaves
 *    working `toHex`/`toBase64`/`fromHex`/`fromBase64` behind even when all four exist but
 *    throw. core-js alone keeps a present `fromHex` and a `fromBase64` that passes its edge
 *    probes, so this pins the probe-and-remove step that runs before it.
 * 2. The polyfills evaluate before any `@protontech` module in the SDK client's import graph.
 * 3. Loading Air Sync (the built-in backend registry) evaluates none of it: the module loads
 *    the SDK client only on first Proton Drive use, so a runtime that cannot run the SDK
 *    breaks only this backend.
 */
import { buildSync } from "esbuild";

const assert = process.getBuiltinModule("node:assert/strict");
const { execFileSync } = process.getBuiltinModule("node:child_process");
const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");
const { dirname, resolve } = process.getBuiltinModule("node:path");
const test = process.getBuiltinModule("node:test");

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, "src/backends/protondrive");

test("the polyfill entry repairs hex/base64 built-ins that exist but throw", () => {
	const bundle = buildSync({
		entryPoints: [resolve(MODULE_DIR, "polyfills.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		write: false,
	}).outputFiles[0].text;
	const script = `
		const broken = () => { throw new TypeError("(intermediate value).toHex is not a function"); };
		for (const [owner, name] of [[Uint8Array.prototype, "toHex"], [Uint8Array.prototype, "toBase64"], [Uint8Array, "fromHex"], [Uint8Array, "fromBase64"]]) {
			Object.defineProperty(owner, name, { value: broken, configurable: true, writable: true });
		}
		require("node:vm").runInThisContext(${JSON.stringify(bundle)});
		const bytes = new Uint8Array([0, 15, 255]);
		process.stdout.write(JSON.stringify([
			bytes.toHex(), bytes.toBase64(), bytes.toBase64({ alphabet: "base64url" }),
			[...Uint8Array.fromHex("000fff")], [...Uint8Array.fromBase64("AA//")],
		]));
	`;
	const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
	assert.deepEqual(JSON.parse(out), ["000fff", "AA//", "AA__", [0, 15, 255], [0, 15, 255]]);
});

/** Static (not dynamic) import graph from `entry`, in ES evaluation order. */
function evaluationOrder(entry) {
	// ES modules evaluate depth-first, dependencies before dependents, in import order.
	const order = [];
	const seen = new Set();
	const visit = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const [, specifier] of readFileSync(file, "utf8").matchAll(/^import (?!type )[^"]*"([^"]+)";$/gm)) {
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), `${specifier}.ts`);
				if (existsSync(target)) visit(target);
			} else if (!seen.has(specifier)) {
				seen.add(specifier);
				order.push(specifier);
			}
		}
		order.push(file);
	};
	visit(entry);
	return order;
}

test("the polyfills evaluate before any @protontech module", () => {
	const order = evaluationOrder(resolve(MODULE_DIR, "sdk-client.ts"));
	const removal = order.indexOf(resolve(MODULE_DIR, "broken-builtins.ts"));
	const firstCoreJs = order.findIndex((entry) => entry.startsWith("core-js/"));
	const firstProton = order.findIndex((entry) => entry.startsWith("@protontech/"));
	assert.ok(removal >= 0, "broken-builtins.ts is in the import graph");
	assert.ok(firstCoreJs > removal, "broken built-ins are removed before core-js evaluates");
	assert.ok(firstProton > order.indexOf(resolve(MODULE_DIR, "polyfills.ts")), "polyfills evaluate before @protontech");
});

test("loading the backend registry evaluates no Proton SDK, crypto or polyfill", () => {
	const statically = evaluationOrder(resolve(MODULE_DIR, "module.ts"));
	assert.deepEqual(statically.filter((entry) => /^(@protontech\/|core-js\/)/.test(entry)), [], "module.ts imports no SDK statically");

	// The production bundle shape (esbuild, cjs): load the registry and check that core-js,
	// which the SDK client imports first, never ran.
	const bundle = buildSync({
		entryPoints: [resolve(ROOT, "src/fs/modules/builtin-modules.ts")],
		bundle: true,
		platform: "browser",
		format: "cjs",
		target: "es2018",
		tsconfig: resolve(ROOT, "tsconfig.bundle.json"),
		external: ["obsidian"],
		write: false,
		logLevel: "error",
	}).outputFiles[0].text;
	const script = `
		const module = { exports: {} };
		new Function("module", "exports", "require", ${JSON.stringify(bundle)})(module, module.exports, require);
		const ids = module.exports.BUILTIN_BACKEND_MODULES.map((m) => m.id);
		process.stdout.write(JSON.stringify({ ids, coreJs: "__core-js_shared__" in globalThis }));
	`;
	// Through stdin: the bundle is too large for a command-line argument.
	const out = JSON.parse(execFileSync(process.execPath, ["-"], { input: script, encoding: "utf8" }));
	assert.ok(out.ids.includes("protondrive"), "the Proton module is registered");
	assert.equal(out.coreJs, false, "core-js (and so the SDK client) did not evaluate at load");
});
