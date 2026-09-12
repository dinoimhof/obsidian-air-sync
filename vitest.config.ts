import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
		exclude: [
			"src/fs/googledrive/test-helpers.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			// Ratchet floors: set a few points below current coverage so a
			// regression fails CI, while leaving headroom for refactors. Raise
			// these as coverage improves — do not lower them to make CI pass.
			thresholds: {
				lines: 76,
				statements: 75,
				functions: 70,
				branches: 65,
			},
			// Production code only: test contracts live outside src, so this
			// denominator excludes only colocated tests/doubles and pure types.
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.d.ts",
				"src/__mocks__/**",
				"src/**/test-helpers.ts",
				"src/**/types.ts",
				"src/main.ts",
			],
		},
	},
	resolve: {
		alias: {
			obsidian: "./src/__mocks__/obsidian.ts",
			// @protontech/crypto ships raw, uncompiled .ts source (gated behind a
			// "browser" package.json export condition) that executes browser-only code
			// (WebCrypto/openpgp) at import time — see docs/protondrive-backend.md and
			// src/__mocks__/protontech-crypto.ts. Under plain Node this both violates
			// Node's restriction on stripping types for files under node_modules and
			// crashes on missing browser globals. Vite's own dependency-optimizer SCAN
			// crawls the whole reachable import graph at worker startup — independent of
			// any per-test `vi.mock()`, which only intercepts runtime resolution, not
			// that earlier static scan — so merely having `fs/protondrive/provider.ts`
			// (imported for real by fs/registry.ts) reachable crashes the WHOLE worker
			// process, poisoning every other test file it happens to run, even when no
			// individual test actually executes the SDK. Aliasing these four specifiers
			// to trivial local stubs (never meant to be functionally exercised — every
			// test that needs real behavior mocks the platform/ files that wrap them)
			// keeps the scanner from ever reaching the real packages.
			"@protontech/crypto/proxy/endpoint/api.ts": "./src/__mocks__/protontech-crypto-endpoint.ts",
			"@protontech/crypto/srp": "./src/__mocks__/protontech-crypto-srp.ts",
			"@protontech/crypto": "./src/__mocks__/protontech-crypto.ts",
			"@protontech/drive-sdk": "./src/__mocks__/protontech-drive-sdk.ts",
		},
	},
});
