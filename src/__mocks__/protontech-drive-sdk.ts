// Vitest-only stand-in for @protontech/drive-sdk (aliased in vitest.config.ts).
//
// See protontech-crypto.ts in this directory for why this stub exists — the same
// raw-TS/browser-only-execution problem applies transitively here too, since the
// real package depends on @protontech/crypto. No test in this repo exercises this
// module's real behavior: every test that needs a Proton Drive client mocks
// `platform/protondrive.ts` (or the files that import it) directly.
export const VERSION = "0.0.0-stub";
