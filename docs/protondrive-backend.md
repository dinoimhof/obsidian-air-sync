# Proton Drive backend (in progress)

This document tracks the Proton Drive backend's design decisions as they're made,
following the same extension points as [Google Drive](google-drive-backend.md),
[Dropbox](dropbox-backend.md), and [OneDrive](onedrive-backend.md). It starts as a
decision record (Step 0 of the implementation plan) and grows into full backend
documentation as each step lands.

## Status

Not yet implemented. This file currently records the pre-implementation spike
decisions; sections below get filled in as each step of the implementation lands.

## Open risks and decisions

### Licensing (resolved)

Proton's SDK stack (`@protontech/drive-sdk`, peer-dependency `@protontech/crypto`) is
**GPL-3.0-licensed**. This repository is MIT-licensed, copyright Takehito Gondo (see
[LICENSE](../LICENSE)) — this fork does not hold copyright over that existing code and
cannot unilaterally relicense it.

Decision: existing MIT-licensed files and their copyright are left untouched. New
Proton Drive backend files (`src/fs/protondrive/**` and any Proton-specific platform
boundary) each carry their own `SPDX-License-Identifier: GPL-3.0-or-later` header,
since they are new original work that bundles a GPL-3.0 dependency. Because MIT and
GPL-3.0 are compatible for combination, this does not require changing any existing
file's license — but it does mean: **a built `main.js` that includes the Proton Drive
backend is a combined work subject to GPL-3.0 for that distribution** (source
availability, same-license redistribution, etc. for the combined binary), even though
the pre-existing MIT files keep their MIT notice. This must be disclosed to users
building/distributing a Proton-enabled build (release notes, README), and is a decision
this fork's owner made independently of the upstream MIT project — it does not change
upstream's licensing and should not be assumed to be mergeable upstream without the
original maintainer's own decision on this question.

### SDK maturity (open, tracked)

`@protontech/drive-sdk` is pre-1.0 (v0.21.0 at time of writing) and its README states
the public interface "may still change" and it is "not ready for third-party production
use." This backend is built against the current interface and will need maintenance as
the SDK stabilizes.

### Cryptographic model migration (open, tracked)

Proton has announced a breaking cryptographic model change targeted for "end of
2026/early 2027." A client implementing only the current model will stop
interoperating once the service switches. This backend will need a follow-up update
when that migration ships; there is no mitigation available before Proton publishes
the new model's SDK support.

### Auth callback shape (resolved)

Proton's session-fork mechanism has **no callback URL at all** — confirmed by reading
the actual (not summarized) source of a real, shipping reference plugin
(`github.com/yunusey/obsidian-proton-integration`, `src/proton/api/{auth,auth-web,
account-api}.ts`), and independently confirmed live against the real API
(`https://drive-api.proton.me/auth/v4/sessions/forks` returns `{Code, Selector,
UserCode}` for an unauthenticated request with just an `x-pm-appversion` header):

1. `POST /auth/v4/sessions/forks` (unauthenticated) returns a `Selector` and a
   `UserCode`.
2. The client generates a random 256-bit AES key locally (`crypto.getRandomValues`,
   never transmitted), and builds a sign-in URL of the form
   `https://account.proton.me/desktop/login?app=drive&pv=3#payload=<urlencoded
   "0:<UserCode>:<base64 key>:external-drive">` — the key lives only in the URL
   **fragment**, consumed client-side by Proton's own login page's JS, never sent to
   any server.
3. The user opens that URL in a real browser and signs in on Proton's own origin — the
   plugin never sees or collects a password.
4. The client polls `GET /auth/v4/sessions/forks/<Selector>` every 5s (a 422 response
   means "not ready yet"), up to a 10-minute timeout.
5. Once ready, the response carries `{ Payload, UID, AccessToken, RefreshToken }`.
   `Payload` is AES-256-GCM ciphertext, decrypted locally with the key from step 2
   (`crypto.subtle.decrypt`, additional-data `"fork"`) to yield `{ keyPassword }`.

This means `src/fs/protondrive/auth.ts` does **not** go through the existing
`obsidian://air-sync-auth` protocol handler / `oauth-callback-error.ts` pipeline at
all — no change needed there. `startAuth()` opens the sign-in URL and itself performs
the bounded poll (Branch B from the implementation plan), returning tokens +
`keyPassword` directly once the fork resolves. The `x-pm-appversion` header (format
`external-drive-<name>@<semver>-<channel>`) is required on every request, matching
Proton's documented operational guideline for third-party apps.

A throwaway Node spike (`proton-auth-spike.mjs`, kept outside this repo, per Step 0b)
reimplements this exact flow using only native `fetch`/`crypto.subtle` — no SDK
dependency needed to prove the handshake itself. **Verified end to end against a real
Proton account**: `sessionForksInit` → browser sign-in → polled `sessionForksStatus` →
AES-GCM payload decryption → an authenticated `GET /core/v4/addresses` call all
succeeded (HTTP 200) with no SDK involved at all.

### SRP is not needed for v1

The reference plugin's `Srp` class (wrapping `@protontech/crypto/srp`) backs a
*direct* username/password login path, which the session-fork flow above bypasses
entirely. Since this backend's auth model is exactly "open the browser, never touch
the password," `@protontech/crypto`'s SRP module is not needed for v1 — narrower
dependency surface than the original plan assumed.

### SDK round trip (verified against a real account)

A second throwaway spike (`proton-sdk-spike/`, esbuild-bundled, kept outside this
repo) took the session-fork login above further: it decrypted the account's real user
and address private keys (`CryptoProxy.importPrivateKey` with the fork's
`keyPassword`, then the address key's `Token`/`Signature` chain for the modern
key-encryption shape — logic mirrored from the reference plugin's
`src/proton/api/addresses.ts`), constructed a real `ProtonDriveClient`
(`httpClient`/`entitiesCache`/`cryptoCache`/`account`/`openPGPCryptoModule`/
`srpModule`/`config.clientUid`), fetched the real "My files" root folder, uploaded a
small test file, downloaded it back, verified the bytes matched exactly, and trashed
the test file. **All of this succeeded against a live Proton account.**

Concrete build/runtime findings from getting there:

- `@protontech/crypto`/`@protontech/openpgp` ship raw TypeScript/browser-targeted
  source (their `package.json` `exports` map points `.` straight at `.ts` files, and
  gates the real OpenPGP implementation behind a `"browser"` export condition). They
  **cannot** be run as plain Node/CommonJS — they must go through a bundler.
  esbuild (`--platform=browser`, this project's implicit default since
  `esbuild.config.mjs` never sets `platform`) bundles the whole stack into one file
  successfully, with no separate `.wasm` asset produced and no unresolved imports.
- `@protontech/openpgp`'s fingerprint/hash code calls the `Uint8Array.prototype.toHex`
  / `toBase64` (and `fromHex`/`fromBase64`) methods from a recent JS-engine proposal.
  **Neither Node 22.23 nor Node 24.21's V8 build implements these yet** — every Node-based
  test needed a small polyfill to proceed. This is very likely a Node-specific gap
  rather than a real Obsidian-environment problem (Electron tracks Chromium's V8 far
  more closely than Node does), but that is still an assumption pending direct
  verification inside an actual Obsidian desktop build — tracked as the remaining
  open item below.
- `@protontech/drive-sdk` pins its own nested `@noble/hashes@^1.8.0`, independent of
  `@protontech/crypto`'s `@noble/hashes@^2.x` — npm naturally installs **two** copies
  side by side, and that is correct: each package's own subpath-import shape (e.g.
  `@noble/hashes/legacy`, `@noble/hashes/utils`) only resolves against its own pinned
  major version's export map. Do not force a single shared version via `overrides` —
  it breaks `drive-sdk`'s own imports.
- The SDK's `HTTPClient` transport interface (`fetchJson`/`fetchBlob`, returning a
  standard web `Response`) is trivially satisfiable by an Obsidian `requestUrl()`
  adapter, confirming every network call in this backend can go through `requestUrl()`
  per this repo's lint-enforced convention — proven by both the reference plugin's
  real code and this spike's own working transport.
- Some pre-existing nodes on the test account produced non-fatal
  `verificationError`/`WARNING` log lines ("Could not find signing key with key ID
  ...") for content predating 2024 — the SDK logs and continues rather than treating
  it as fatal. Only an explicit thrown error (e.g. the `IntegrityError` this spike hit
  and fixed — caused by an incomplete `getPublicKeys` in the spike's own scaffolding,
  not an SDK defect) should be treated as a real failure; legacy-signature warnings on
  content this backend didn't itself write are expected account-history noise, not a
  bug to chase.

### Mobile WASM/worker bundling (open, partially de-risked)

Bundling itself works (see above) and needs no special WASM loader in
`esbuild.config.mjs`. What remains genuinely unverified is whether the bundle
*executes* correctly inside Obsidian's actual mobile WebView (iOS WebKit vs. Android's
Chromium-based WebView have different timelines for the `Uint8Array` hex/base64
proposal and for WASM/Worker support) — this needs a real on-device smoke test before
this backend is scoped as mobile-compatible, not just a desktop Electron test.

## Full backend documentation

To be written once the implementation lands (addressing model, auth model, secret
storage, checksum algorithm, incremental sync mechanism) — see
[dropbox-backend.md](dropbox-backend.md) for the target structure.
