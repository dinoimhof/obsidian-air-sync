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

### Mobile WASM/worker bundling (pending verification)

`@protontech/crypto` bundles OpenPGP.js with a WASM implementation and an asm.js
fallback, and offloads work to Web Workers via `comlink`. This plugin's
`esbuild.config.mjs` currently has no WASM loader and externals all `node:*` builtins
(fine on desktop's Electron/Node renderer, a hard failure on mobile if ever reached).
Whether this bundles and runs correctly in Obsidian's mobile WebView is being smoke
tested before this backend is scoped as mobile-compatible.

## Full backend documentation

To be written once the implementation lands (addressing model, auth model, secret
storage, checksum algorithm, incremental sync mechanism) — see
[dropbox-backend.md](dropbox-backend.md) for the target structure.
