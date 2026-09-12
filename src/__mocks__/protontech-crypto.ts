// Vitest-only stand-in for @protontech/crypto (aliased in vitest.config.ts).
//
// @protontech/crypto ships raw, uncompiled TypeScript gated behind a "browser"
// package.json export condition (see docs/protondrive-backend.md), and executes
// browser-only code (WebCrypto/openpgp) at import time. Under plain Node — which is
// how Vitest runs this project's tests — that both violates Node's restriction on
// stripping types for files under node_modules and crashes on missing browser
// globals. No test in this repo exercises this module's real behavior: every test
// that needs Proton Drive crypto mocks `platform/protondrive-crypto.ts` (or the
// files that import it) directly. This stub only needs to exist so nothing — not
// even an unrelated test file, via Vite's own project-wide dependency scan — ever
// tries to load the real package.
export const CryptoProxy = {};
