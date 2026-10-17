---
id: design-protondrive-hardening
kind: design
title: Proton Drive backend hardening review
status: proposed
created: '2026-10-17'
updated: '2026-10-17'
relations:
- {type: references, target: design-remote-backend-implementation-contract}
- {type: references, target: design-backend-module-api}
summary: Concept-by-concept review of the Proton Drive module (keep or change, and why), and
  the individually acceptable hardening changes that follow from it.
---

# Proton Drive backend hardening review

This review covers the Proton Drive module (`src/backends/protondrive/`). It checks the
module against the remote backend implementation contract, against Proton's official
incubating account module and web clients, and against failure modes seen while testing
against a real account. For each concept it decides **keep** or **change**. Every change is
a separate, self-contained commit that a maintainer can accept or drop on its own.
Anything that would need core or `src/backend-api/` changes is out of scope here and
tracked as an issue.

The two assets that matter most are the **session**, whose tokens carry full account API
scope, and the **key password**, which unlocks every user and address key: Mail and
Calendar keys too, not only Drive. Each decision below is weighed against the effect of
leaking or misusing these two.

## 1. Entity cache and full listing cost

The SDK entity cache is a `NullCache`, so every node read is a fresh API read. `listAll`
walks the bound tree one folder at a time, and `getByPath` lists every folder on the way
to the target.

**Keep.** Detached priority reads and post-write proofs must see current facts, and
Proton's guideline ("avoid frequent recursive traversals") is met because core calls
`listAll` only on COLD (first sync, `cursor_invalid`, scope change). HOT and WARM use the
event feed. The cost of `getByPath` (depth × folder size) is documented as a known
limitation. A caching entity store would need the SDK's own event subscription to stay
correct, and that would make the SDK a second state owner beside core's checkpoint.

## 2. Event scope and delta shape

The cursor is a volume event id. Events are volume-wide and name only the touched node.
Each delta re-reads the touched nodes in one batch, and core drops objects outside the
bound root.

**Keep the shape; change the default branch.** `readEvents` currently advances the cursor
past any event type it does not list. A future Proton event type that carries a real
change would be skipped forever, and the two sides would silently drift apart. Unknown
types must yield `refresh` (a full rescan). `SharedWithMeUpdated` stays explicitly ignored
because shared content is out of scope.

## 3. Sign-in: poll-completed session fork

The session fork has no redirect back to Obsidian. The module declares
`auth.completion: "poll"`. The pending fork (its selector and AES key) lives in
SecretStorage, so a sign-in survives the app being suspended on mobile. The flow matches
Proton's incubating `authWeb.ts`: AES-256-GCM, the `fork` additional data, and Proton's own
polling schedule.

**Keep.** It is the only correct shape for this provider, and it is better than an
in-process poll that dies when the app is backgrounded. The flow adds public API surface
(`BackendAuth.completion`, `BackendBinding.appRoot`, the generalized
`listAppRootFolders`). For an upstream PR, that surface should land as its own
core-tested commits ahead of the Proton module, which is a packaging step and not a code
change here. Two changes elsewhere: a stale `pending-fork` must not outlive Disconnect
(see 7), and the selector must never reach a log (see 5).

## 4. Session and secret shape

The session is one atomic JSON secret (`session`: uid, tokens, key password). Refresh is
single-flight and re-reads the store first, so a rotated refresh token is never replayed.
`clientUid` lives in backend data; it is not a secret.

**Change: the key password must not be stored in plaintext.** Proton's own web clients
store a persisted session's key password encrypted with a random client key. Proton's
server holds that key for the session (`auth/v4/sessions/local/key`; WebClients
`packages/shared/lib/api/auth.ts`, `authentication/clientKey.ts`). The module adopts the
same pattern. Once the session is revoked (Disconnect, "sign out of all sessions", or a
password change), any stored or backed-up copy of the secret becomes permanently
undecryptable. If Proton refuses the endpoint for a forked third-party session, the
module falls back to today's storage and warns once. A session stored in the old shape is
treated as absent, so the user reconnects once; there is no migration code.

Obsidian's SecretStorage is app-global (`listSecrets()`), and the plugin can do nothing
about another plugin reading it while Air Sync runs. The docs must say so plainly. An
opt-in passphrase lock and a "don't remember this device" mode would need core support,
so they are tracked as issues.

## 5. Error messages and logs

`ProtonApiError` messages embed the full request path, including the fork selector and
`keys/all?Email=…`, plus Proton's free-text `Error`. `account.ts` interpolates address
emails. SDK log messages are forwarded unfiltered. Core's redaction strips only OAuth
query parameters and `Bearer` values. Logs live in `.airsync/logs/` inside the vault.

**Change, with two layers.**
1. **At the source:** messages carry the method, a sanitized route and the numeric code
   only. A generic sanitizer drops the query string and replaces every path segment that
   is not a short lowercase route word (`core`, `v4`, `forks`) with `{id}`. Because it is
   an allowlist, new routes and new id shapes are covered without a template list. Emails, the selector, the configured folder path and
   Proton's free-text detail never appear.
2. **At the module's logger boundary**, including SDK telemetry: a scrubber removes email
   addresses, fork selectors, bearer and refresh tokens, and query strings as defense in
   depth.

## 6. Transport

All requests go through `context.http` (`requestUrl`). The transport sets the session
headers, refreshes and replays once on a 401, and enforces a deadline. FormData and Blob
bodies are encoded through the platform `Request` (no network).

**Change: allowlist the hosts.** Today the session headers go to any URL the SDK names,
including storage block URLs taken from server responses. Requests must be `https` on
`proton.me` or a subdomain. Anything else fails permanently before it is sent. The 401
refresh runs only for the API host, because a storage 401 is a storage-token problem, not
a session problem. Whether storage hosts need the session headers at all is verified in
the live test. If they do not, a follow-up restricts the headers to the API host.

The deadline cannot cancel `requestUrl`, so a retried POST may land twice. This is
documented as a residual risk, and Obsidian offers no fix.

## 7. Key and crypto lifetime

Every `openProtonDrive` call (adapter, default binding, display path, folder picker, auth
completion) builds a new client and account and re-imports the user keys into the
process-global `CryptoProxy` key store. Nothing releases them.

**Change.** One connection per runtime context, held in a `WeakMap` keyed by the context.
On revoke, the module clears the crypto key store and drops the memoized connection.
`auth.start` discards a stale `pending-fork`, and expiry and revoke delete it. Releasing
keys on plugin unload needs a core dispose hook for adapters, which is tracked as an
issue.

## 8. Remote facts entering core

Decrypted names reach core after only the SDK's empty/length check, and core's
`validateRemoteObject` requires only a string. File content is accepted as long as the
SDK's download signature checks pass.

**Change, two commits.**
- **Name guard.** A name that is empty, `.` or `..`, or contains `/`, `\`, NUL or another
  C0 control or DEL character is treated as undecryptable. Inside the bound root that
  fails closed; outside it is ignored. This prevents path confusion and log-line
  injection. The same rule applies to typed folder paths. The core-wide gap is tracked as
  an issue.
- **Read verifies the checksum.** After a version-bound download, the module recomputes
  SHA-1 and compares it with the revision's claimed digest. On a mismatch it returns
  `unverifiable`. Core trusts the claimed SHA-1 for local/remote equality, so a revision
  whose bytes and claim disagree, whether from another client's bug or from a future SDK
  or crypto change, must never become evidence.

## 9. Error semantics for provider-side change

Unknown SDK errors map to `transient`. So does the plain `Error` thrown when no user key
decrypts.

**Change.**
- Code `5003` ("You need to update this app", in Proton's OpenAPI types) becomes
  permanent, with an "update Air Sync" message.
- "API call succeeded but no user key imports with the stored key password" becomes
  `auth` ("reconnect"). That is what a password change produces, and it must never take
  a destructive path.
- `ProtonApiError` carries `Retry-After`, so 429/503 responses from the module's own calls
  set a bounded `retryAfterMs`.

The `transient` default for genuinely unknown errors stays, because core already bounds
retries and quarantines persistent failures.

## 10. Polyfills and forward compatibility

`core-js` patches `Uint8Array` base64/hex, `Array.fromAsync`, iterator helpers and
`Promise.withResolvers` only where they are missing or misbehave. Its detection calls the
methods; it does not just check their type. That covers the partial Electron rollout seen
in live testing. The crypto package's types come from a hand-written declaration mapped
through `tsconfig.paths`.

**Keep core-js, and pin it with tests.**
- A unit test simulates the partial rollout.
- The polyfills must evaluate before any `@protontech` module.
- An offline smoke test bundles the real SDK and crypto, then runs key import plus an
  encrypt, decrypt, sign and verify round trip and builds a `ProtonDriveClient`. This
  catches API drift that the hand-written types hide.
- An upgrade runbook in the backend doc covers the next SDK or crypto-model bump.

## Refines

How each hardening change follows this review (section numbers in brackets):

| Item | Refinement |
|---|---|
| Log and error hygiene (5) | Generic route sanitizer instead of per-route templates. The configured folder path and typed folder input are never echoed into errors or logs. The scrubber sits in `telemetry()` and wraps `context.logger` for module messages. |
| Transport host allowlist (6) | Allowlist is `https` + `proton.me` or a subdomain. Session headers go to allowlisted hosts. Refresh is for the API host only. Whether storage needs the headers is a live-check item. |
| Remote fact validation (8) | The guard also rejects C0 control characters and DEL. A second commit makes `read` verify the downloaded SHA-1 against the claimed digest (see 8). |
| Key and secret lifetime (7) | Memoize per context with a `WeakMap`. Revoke clears the whole crypto key store, since the endpoint is used only by this module, and drops the memo. |
| Provider error semantics (9) | Only `5003` is mapped as "app update required", because it is the only code confirmed in Proton's API types. |
| Key password at rest (4) | The local-key fallback warns once without any value. Old-shape sessions are treated as absent. |
| Backend documentation | The docs cover sections 1, 4, 6 and 10 residual risks and the upstream packaging note from 3. |
