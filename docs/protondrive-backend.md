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
requirements once the backend was registered for real, not deferrable). **The backend
is now selectable from Obsidian's settings UI and can connect, bind a folder, and
sync.** Remaining: a fuller settings-UI pass (Step 8, if the current one proves too
minimal in practice), the opt-in live E2E suite (Step 10), and the final hardening
pass (Step 11).

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
`setBackendSecret`, name `"clientUid"`) rather than in `settings.backendData` — the
latter is cleared on every backend switch, while Proton correlates this id across the
client's whole lifetime on this installation, not just one connected session. It is
deliberately excluded from the secret names `clearPluginSecrets()` sweeps on
disconnect, so it survives a disconnect/reconnect and a switch away to a different
backend and back.

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
