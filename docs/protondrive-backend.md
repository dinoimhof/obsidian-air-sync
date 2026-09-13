# Proton Drive backend (in progress)

This document tracks the Proton Drive backend's design decisions as they're made,
following the same extension points as [Google Drive](google-drive-backend.md),
[Dropbox](dropbox-backend.md), and [OneDrive](onedrive-backend.md). It starts as a
decision record (Step 0 of the implementation plan) and grows into full backend
documentation as each step lands.

## Status

Steps 0–4 and 6 landed: SDK dependencies + platform boundary (Step 1), session-fork
auth (Step 2), the SDK client wrapper (Step 3), the `IFileSystem` implementation
itself (Step 4, which folded in Step 5's scope since `CachingRemoteFs` requires the
incremental-sync seam to compile at all), and provider/registry wiring plus
remote-vault resolution (Step 6, which pulled forward a minimal but real settings
renderer and the Step 7 contract-harness registration — both turned out to be hard
requirements once the backend was registered for real, not deferrable). Step 10 (the
opt-in live E2E suite, `e2e/protondrive.e2e.ts`) also landed, type-checked but not yet
run live.

**Step 11's manual verification (see the checklist at the end of this document) is
now underway against a real Proton Drive account, and has already found and fixed
five real bugs no unit test caught** (unit test doubles don't enforce the constraints
these tripped on):

1. Two backend-switch/registry bugs only reachable by actually using the settings UI:
   a failure in one backend's token sweep aborted switching to *every* backend, and a
   failed switch left the tab showing a stale backend's connection section.
2. Obsidian's real `SecretStorage.setSecret` rejects camelCase secret ids
   (`"keyPassword"`, `"clientUid"`) — renamed to `"key-password"`/`"client-uid"`, and
   `token-store.ts` now validates this eagerly so it can't regress for a future backend.
3. Pre-sync-cycle failures (connect/auth/folder-pick) weren't reaching
   `.airsync/logs/` at all, since `Logger.flush()` only ran at sync-cycle end or
   plugin unload — fixed to flush immediately at those failure sites, for every backend.
4. **The real live-account blocker**: `@noble/hashes`' feature-detection for the
   `Uint8Array` hex/base64 proposal reported Obsidian's bundled Electron as having it
   when `Uint8Array.prototype.toHex` was not actually callable — a partial,
   inconsistent rollout that crashed the very first Drive SDK call naming a node
   (folder browse/bind). Fixed with `src/platform/protondrive-polyfills.ts` (verifies
   each method by calling it, not just checking its type). See "SDK round trip"
   below for the full story — this was the one open risk flagged since Step 0 that
   turned out to matter.
5. Three error messages interpolated a real account email address or identifier
   directly into text that reaches persisted logs — redacted to reference an opaque,
   non-identifying id instead.

**As of this writing, connecting and folder binding/browsing are confirmed working
live against a real account.** The rest of the Step 11 checklist (multi-restart soak,
crash-safety scenarios, mobile) has not yet been run. A fuller settings-UI pass
(Step 8) remains optional, only if the current minimal one proves insufficient in
practice.

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
- `@protontech/openpgp`'s fingerprint/hash code (via `@noble/hashes`) calls the
  `Uint8Array.prototype.toHex`/`toBase64` (and `fromHex`/`fromBase64`) methods from a
  recent JS-engine proposal. **Neither Node 22.23 nor Node 24.21's V8 build implements
  these yet** — every Node-based test needed a small polyfill to proceed. The
  assumption that real Obsidian desktop (Electron) would simply have these natively
  turned out to be **wrong, and in a more insidious way than a clean absence**: live
  testing against a real account found `@noble/hashes`' feature-detection
  (`typeof Uint8Array.fromHex === "function" && typeof (new Uint8Array()).toHex ===
  "function"`) reporting `true` while `.toHex()` was not actually callable — a
  partial, inconsistent rollout of the proposal in that Electron/V8 build, crashing
  with `"(intermediate value).toHex is not a function"` on the very first Drive SDK
  call that names a node (folder listing/creation — i.e. immediately on trying to
  browse or bind a folder). **Resolved**: `src/platform/protondrive-polyfills.ts`,
  installed from `initProtonDriveCrypto()`, verifies each of the four methods by
  actually *calling* it against a known input (not a `typeof` check) and only
  (re)defines the ones that are missing or misbehave — see that file's own doc
  comment for the full mechanism. Any other backend/environment where this SAME
  partial-rollout pattern could recur is now covered by construction, not by luck.
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
*executes* correctly inside Obsidian's actual mobile WebView — WASM/Worker support
specifically (iOS WebKit and Android's Chromium-based WebView have their own
timelines for both). The `Uint8Array` hex/base64 proposal itself is no longer a
separate mobile unknown: `protondrive-polyfills.ts` (see above) verifies and, where
needed, replaces those methods regardless of platform, so a mobile WebView with the
same partial-rollout gap desktop Electron had is already covered. A real on-device
smoke test is still needed before this backend is scoped as mobile-compatible, not
just a desktop Electron test — WASM/Worker availability is the part that test would
actually be proving.

## Full backend documentation

### Addressing model and metadata cache

Proton Drive addresses content by an opaque, per-node `uid` in a strict single-parent
tree (`NodeEntity.parentUid`) — structurally identical to OneDrive's
`id`/`parentReference.id`, not Google Drive's multi-parent model. `ProtonDriveFs`
(`src/fs/protondrive/index.ts`) extends `CachingRemoteFs<ProtonDriveNode>` and
`ProtonDriveMetadataCache` extends `AbstractMetadataCache` exactly like the other
id-addressed backends; `platform/protondrive.ts` projects the SDK's `NodeEntity` into
the first-party `ProtonDriveNode` shape so no other file needs its own unknown-narrowing
of `@protontech/drive-sdk`'s node types.

An undecryptable node name (the SDK's `Result<string, Error | InvalidNameError>` coming
back `ok: false`) is surfaced as a stable, uid-derived placeholder rather than dropped —
silently hiding it would read downstream as a deletion (see this repo's "never derive a
deletion from listing-absence alone" convention).

### Checksum: "opaque" via the active revision uid

Content is end-to-end encrypted; there is no locally-reproducible plaintext hash the SDK
exposes (the closest analog, `Revision.claimedDigests.sha1`, is attacker-controlled
cleartext metadata, "claimed" only, never server-verified — unsafe to use for identity).
Instead, `remoteChecksum` uses `{ algo: "opaque", value: <active revision uid> }`: the
SDK mints a fresh revision (and thus a fresh uid) on every content change, so it serves
the same "did this change" role as Dropbox's/OneDrive's checksums without claiming to be
a reproducible content hash — matching this type's existing `"opaque"` contract (added
for pCloud).

### No native flat listing or path lookup

Unlike Graph's `/delta` or Google Drive's `files.list`, the SDK exposes only
per-folder child iteration (`iterateFolderChildrenNodeUids` + `iterateNodes`) and no
path-relative addressing at all. `ProtonDriveClient.fullList()`
(`src/fs/protondrive/drive-client.ts`) therefore walks the tree one folder at a time to
build a full listing, and path segment lookups (`getChildByName`) list a folder's
children and match by name client-side. This is a known scaling limitation for very
large vaults — each folder in the tree costs its own round trip — that a future
optimization could address if it becomes a real-world bottleneck, but is not worth
front-loading before it is observed to matter.

### Incremental sync: `iterateEvents`, not a paginated delta

The SDK's event stream (`iterateEvents(treeEventScopeId, lastEventId)`) is coarser than
Graph's/Google Drive's delta: each event carries only a node uid and a change kind
(`node_created`/`node_updated`/`node_deleted`), never the changed metadata itself — an
upsert event re-fetches the node with `getNode` (`src/fs/protondrive/incremental-sync.ts`).
The cursor is a `(treeEventScopeId, eventId)` pair, encoded as a small JSON string (the
only shape `CachingRemoteFs`'s single opaque-string cursor slot expects). A
`tree_refresh`/`tree_remove` event — the SDK's own server-initiated resync signal —
requests a full scan, exactly like Google Drive's/OneDrive's HTTP 410 handling.

The event *scope* is shared by the whole tree the configured sync root lives in (per the
SDK's own doc: "the scope can comprise one or more folder trees"), so the stream can
include nodes outside the configured `AirSync/<vault>` root when other content shares the
same Drive volume. Those events resolve to no path (their parent chain never reaches the
configured root) and are silently no-ops — the same mechanism that already ignores
irrelevant Google Drive changes — but it does mean a very active account could burn
through the per-cycle event cap on unrelated activity; documented here as a known,
currently unoptimized cost rather than silently degraded correctness.

### Non-atomic rename+reparent

The SDK exposes `renameNode` and `moveNodes` as two separate calls with no combined
rename-and-move endpoint (unlike Graph's single PATCH). `ProtonDriveClient.move()` issues
them sequentially; a failure between the two leaves the node moved-but-not-renamed (or
vice versa) rather than atomically neither. This mirrors the same two-call shape as the
SDK itself, is retried by the ordinary sync-cycle failure handling like any other
mid-operation exception, and does not corrupt cache state (the final `getNode` re-fetch
after both calls reflects whatever the server actually ended up with).

### Secret storage, auth model

See [the auth section above](#auth-callback-shape-resolved) for the session-fork model;
secrets (session UID, access/refresh tokens, `keyPassword`) persist via
`publishBackendSecret`/`getBackendSecret` (`src/fs/token-store.ts`), never
`data.json` — see `src/fs/protondrive/auth.ts`. Decrypted private keys are never
persisted; they are re-derived in memory each session from the freshly-fetched
encrypted key blob (`src/fs/protondrive/addresses.ts`).

Still to be written once the remaining steps land: the opt-in live E2E suite (Step 10)
and the final hardening pass (Step 11) — see [dropbox-backend.md](dropbox-backend.md)
for the target structure this will converge on.

### Provider, registry wiring, and remote-vault resolution (Step 6)

`ProtonDriveProvider` (`src/fs/protondrive/provider.ts`) implements `IBackendProvider`
directly — unlike OneDrive/Dropbox (which share `PkceAppFolderProvider`), Proton's
session-fork auth and full-drive scope don't fit that generic PKCE/app-folder base, so
it's modeled on `GoogleDriveProviderBase`'s shape instead (own `makeClient`, no shared
base class). `resolveProtonDriveRemoteVault` (`remote-vault.ts`) mirrors
`resolveGoogleDriveRemoteVault`'s two-level `obsidian-air-sync/<Vault Name>`
find-or-create, except `ProtonDriveClient.createFolder` is already idempotent
(find-or-create in one SDK-shaped call), so there's no separate "find, then create"
step. A picked folder (via the in-app browser, `ui/protondrive-folder-picker.ts`) binds
directly by uid (`ProtonDriveProvider.bindPickedFolder`) rather than through the
OneDrive/Dropbox `pendingPickedFolderPath`-under-a-fixed-root convention — full-drive
scope means there is no fixed root to resolve a name under.

**`clientUid`** (a stable per-installation identifier the SDK's `config.clientUid`
requires, unrelated to the session's own uid) is generated once via
`crypto.randomUUID()` and persisted as a plugin secret (`getBackendSecret`/
`setBackendSecret`, secret name `"client-uid"` — dash-separated: Obsidian's real
`SecretStorage.setSecret` requires a lowercase-alphanumeric-with-dashes id and throws
on a camelCase one like `"clientUid"`, caught only by a live connection attempt, not
by any test double — see `token-store.ts`'s `secretKey()` guard) rather than in
`settings.backendData` — the latter is cleared on every backend switch, while Proton
correlates this id across the client's whole lifetime on this installation, not just
one connected session. It is deliberately excluded from the secret names
`clearPluginSecrets()` sweeps on disconnect, so it survives a disconnect/reconnect and
a switch away to a different backend and back.

**Settings UI** (`ui/protondrive-settings.ts`, `ui/protondrive-folder-picker.ts`): a
connection-status row, an explicit disclosure that this backend has no per-app
scoping (full-drive access, unlike OneDrive/Dropbox), and a remote-folder field that
either binds the default `obsidian-air-sync/<Vault Name>` folder or opens an in-app
folder browser. The browser drills down from "My files" one folder at a time (there is
no arbitrary-depth tree view) since the SDK exposes no flat listing to browse against —
matching `ProtonDriveClient.fullList`'s own per-folder-walk limitation (see above).

### A vitest-only landmine: never let `@protontech/*` load for real in tests

`@protontech/crypto` (and transitively `@protontech/drive-sdk`) ships raw, uncompiled
TypeScript gated behind a "browser" package.json export condition, and executes
browser-only code (WebCrypto/openpgp) at *import* time, not just when its functions are
called. Under Vitest's plain-Node test environment this is fatal twice over: Node
refuses to strip types for anything under `node_modules`, and even past that, the
browser-only code itself throws (no `window`/WebCrypto in that environment).

The dangerous part: Vite's dependency-optimizer performs its own static scan of the
whole reachable import graph at worker startup — independent of any per-test
`vi.mock()`, which only intercepts *runtime* module resolution, not that earlier static
scan. Once `fs/protondrive/provider.ts` became reachable for real from `fs/registry.ts`
(Step 6), merely having it on the graph crashed the *entire worker process*, silently
failing unrelated tests in other backends' files that never touch Proton Drive at all —
confirmed by bisection with a cleared `node_modules/.vite` cache each time. Per-file
`vi.mock` of `fs/protondrive/client.ts`/`drive-client.ts` (already this backend's own
convention, e.g. `addresses.test.ts` mocking `protondrive-crypto.ts`) fixes the test
that declares it, but not the shared worker's poisoned dependency scan.

The fix that actually holds: `vitest.config.ts`'s `resolve.alias` maps
`@protontech/crypto`, its two subpaths, and `@protontech/drive-sdk` to trivial stub
files under `src/__mocks__/` — the same mechanism already used for `obsidian` itself.
Aliasing happens at resolution time, before esbuild or Node ever see the real package,
so the scanner never reaches the problematic code regardless of which test triggered
it. Any future test that needs *real* Proton Drive SDK behavior is out of scope by
design — verification against the real SDK happens only in the opt-in live E2E (Step
10) and this backend's own manual spike testing, never in the unit suite.

## Step 11 — Hardening pass (manual checklist)

This is a **manual** checklist run against a real Obsidian install and your real Proton
Drive account — nothing here can be automated the way the unit suite or the opt-in e2e
(Step 10) can, because it is specifically testing what those can't: real process
restarts, a real OS-level credential store, real background sync timing, and (if
available) a real mobile device. Nothing here should be run against a vault you can't
afford to lose — use a disposable test vault, or a real one you have a current backup
of.

**Never record secret values** (session uid, tokens, `keyPassword`, clientUid) in
whatever record you keep of this run — only platform/version and pass/fail, exactly
like the SecretStorage checklist in [docs/e2e-testing.md](e2e-testing.md). An unrun
step is `unverified`, not a pass — do not mark something done because it's "probably
fine" from reading the code.

### 0. Build and install

1. `npm run build` (the full gate — lint, `lint:bot-repro`, build, `test:coverage` —
   should already be green from CI/the last commit; re-run it here if anything in the
   working tree has changed since).
2. Copy `main.js`, `manifest.json`, `styles.css` into the test vault's
   `.obsidian/plugins/air-sync/` and enable the plugin.
3. Record: OS, Obsidian version, plugin version.

### 1. Connect and bind a folder

1. Open plugin settings, select **Proton Drive** as the backend.
2. Click **Connect to Proton Drive** — confirm the system browser opens Proton's own
   `account.proton.me` sign-in page (never a plugin-drawn password field).
3. Sign in. Confirm the settings tab shows **● Connected** without you pasting anything
   back into Obsidian (session-fork has no code/token for you to copy).
4. Confirm the **Full-drive access** disclosure text is visible and accurately describes
   the trust footprint (full "My files" reachable, not an app-scoped folder) — this is
   the concrete "strict security posture, made visible to the user" requirement from the
   original implementation plan, not just an internal safeguard.
5. Bind a folder two ways, on two separate runs of this step: once via the default
   button (should create/reuse `obsidian-air-sync/<vault name>` at the Drive root — spot
   check this exists via the Proton Drive web app), and once via **Choose folder**
   (`ProtonDriveFolderPickerModal`): drill into an existing folder, and separately try
   creating a new folder from inside the picker. Confirm the bound folder's name is
   reflected back in settings after either path.

### 2. Multi-restart login persistence soak

The core promise of Step 2's auth work: the plugin must never re-prompt sign-in on an
ordinary reload. This is the step most likely to silently regress if a future change
touches `src/fs/protondrive/auth.ts` or `token-store.ts`.

1. With the backend connected (from step 1), fully quit Obsidian (not just close the
   window — actually terminate the process/app) and relaunch it.
2. Confirm the backend still shows **● Connected** with no sign-in prompt, and that a
   sync runs successfully without any user action.
3. Repeat the full quit/relaunch **at least three times in a row**, running a real sync
   each time. A single successful restart is not enough evidence — the session-fork
   tokens and `keyPassword` are read from SecretStorage fresh on every `getOrCreateAuth()`
   call, and a bug here tends to show up as "works once, then breaks."
4. If your Proton account setup makes it observable without exposing token values
   (e.g. you can tell from Proton's own account activity log), confirm that a session
   refresh at some point during the soak rotates tokens correctly and the connection
   survives the NEXT restart after that rotation too — mirroring the rotation check in
   docs/e2e-testing.md's SecretStorage checklist, and exercising the one part of
   `auth.ts` (`performRefresh`'s `UID` rotation) noted as a latent gap in
   `provider.ts`'s `readBackendState` comment.
5. Disconnect, then reconnect from scratch. Confirm a fresh session-fork sign-in is
   requested (i.e. disconnect actually revoked the local session) and that the
   previously-bound folder is either still bound or cleanly reset, matching what
   `ProtonDriveProvider.disconnect()` promises (`DEFAULT_PROTON_DRIVE_DATA`, secrets
   cleared except `clientUid`).

### 3. Sync correctness smoke test

Exercise the ordinary path once, end to end, on a small real vault:

1. Create a handful of notes (including at least one nested folder, one non-Markdown
   attachment, and one file with a non-ASCII name) and let a sync complete.
2. Confirm all of them appear correctly in the Proton Drive web app, with matching
   content and folder structure.
3. Edit a file locally, let it sync, and confirm the edit lands on Proton Drive.
4. Edit a file's content **on the Proton Drive web app** (not through Air Sync) and
   confirm the change pulls down into the vault on the next sync.
5. Rename a file and a folder locally; confirm both renames propagate remotely without
   showing up as a delete+recreate (check the Proton Drive web app's own version/activity
   view if it exposes one).
6. Delete a file locally; confirm it's removed remotely. Delete a file on the Proton
   Drive web app; confirm it's removed locally on the next sync.

### 4. Crash-safety scenarios

ADR 0001's crash-safety invariants (commit only after a clean cycle) are already proven
at the unit level by `tests/fs/protondrive/caching-remote-fs.contract-harness.ts` — this
step is about the parts only a REAL crash can exercise: real disk I/O timing, a real
IndexedDB, and a real OS process kill.

1. Start a sync involving several files (so it takes a few seconds), and **force-quit
   Obsidian mid-sync** (kill the process, don't use the normal quit).
2. Relaunch. Confirm the plugin recovers cleanly: no duplicate files, no stuck "syncing"
   state, and a normal sync cycle completes on its own without manual intervention
   (Rescan, disconnect/reconnect, etc.).
3. Repeat, but force-quit during specifically a multi-file **upload** batch and, on a
   separate run, during a **download** batch, to exercise both directions.
4. With the plugin already mid-idle, disconnect your machine's network entirely, trigger
   a manual sync, and confirm it fails gracefully (a visible error/notice, not a hang or
   crash) and recovers on the next attempt once connectivity returns.

### 5. Incremental sync fidelity

1. After an initial full sync, make a small remote-only change (add one file via the
   Proton Drive web app) and confirm the next sync picks it up via the event stream
   (`iterateEvents`), not a full rescan — if you have logging enabled
   (`enableLogging`/`logLevel: debug`), the log should show an incremental event
   application, not "Full scan completed."
2. Leave the vault connected but idle for longer than you'd normally leave Obsidian
   open (e.g. overnight), then make a remote change and confirm the next sync still
   picks it up correctly — this exercises the `iterateEvents` cursor staying valid
   across a real gap, not just the wall-clock-independent unit test.
3. If practical, make a change to some OTHER content in the same Proton Drive account
   outside the bound `obsidian-air-sync/<vault>` folder, and confirm it does *not*
   trigger spurious sync activity — this is the "event scope is shared by the whole
   Drive tree, unrelated events silently no-op" behavior documented above; confirm it
   actually holds live, not just in the unit contract.

### 6. Settings UI walkthrough (desktop)

Beyond what steps 1–2 already exercise:

1. With a folder already bound, confirm the settings tab shows the bound folder's
   current name (not just its raw id) via `getRemoteVaultDisplayPath`.
2. Switch the active backend away from Proton Drive to a different one, then switch
   back. Confirm re-selecting Proton Drive does **not** require a fresh sign-in (the
   session secrets and `clientUid` are backend-switch-durable by design — see the
   "clientUid" section above) and that the previously-bound folder is remembered or
   cleanly reset per whatever `settings.backendData` clearing actually does on a
   backend switch — this is the concrete behavior the `clientUid` persistence design
   decision was made to support; confirm it wasn't only true in theory.
3. Confirm `Rescan`/full-resync (if exposed by the plugin's UI) works against Proton
   Drive without error.

### 7. Mobile (best-effort — mark `unverified` if unavailable)

Mobile execution of `@protontech/crypto`'s WASM/worker code was flagged as an **open,
unverified risk** as far back as Step 0 (see "Mobile WASM/worker bundling" above) — this
is the first point in the whole implementation where it can actually be checked against
a real device instead of reasoned about.

1. Install the built plugin on a real mobile Obsidian install (iOS and/or Android — note
   which).
2. Attempt to connect: confirm the session-fork sign-in flow works on mobile (opens the
   system browser or an in-app browser tab; the desktop code path already branches on
   `Platform.isMobile` for this).
3. Attempt a real sync. The specific failure mode to watch for is a crash or hang during
   crypto operations (key decryption, content encryption/decryption) — if the SDK's
   WASM/worker requirements aren't met by the mobile WebView, this is where it will
   surface, not earlier.
4. If mobile fails outright, that is a real, reportable finding for this backend's
   "known risks" — record exactly what happened (error message, at what step) rather
   than silently marking the backend desktop-only after the fact.

### 8. Final sign-off

1. Re-run the full gate one more time on a clean tree: `npm run lint && npm run
   lint:bot-repro && npm run build && npm run test:coverage`.
2. If you were able to run it, `npm run test:e2e:protondrive` from a plain (non-sandboxed)
   shell with real credentials in `.env.e2e` (see docs/e2e-testing.md).
3. Update the Status section at the top of this document to reflect what was actually
   verified live versus still `unverified`, and file/fix anything this checklist turned
   up before considering the backend feature-complete.
