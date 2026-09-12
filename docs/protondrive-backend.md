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

### Auth callback shape (pending live verification)

`IAuthProvider.completeAuth(input: string, backendData)` and this plugin's single
`obsidian://air-sync-auth` protocol handler (`main.ts`, `src/fs/oauth-callback-error.ts`)
only ever see parsed query parameters — there is no URL-fragment handling anywhere in
this pipeline. Proton's session-fork mechanism may return its fork selector via a
callback URL's query string (fits the existing pipeline unmodified), or the client may
instead generate the selector itself and poll `sessionForksStatus()` directly with no
real inbound callback. Which shape actually applies is being verified against a live
Proton account via the throwaway spike script (kept outside `src/`, see the
implementation plan) before `src/fs/protondrive/auth.ts` is finalized.

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
