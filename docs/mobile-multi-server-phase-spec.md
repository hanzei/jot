# Mobile Multi-Server Support Phase Spec

## Purpose

Define a coding-agent-ready implementation plan for adding multi-server support to the mobile app, with a server picker opened from the left-hand-side profile section.

## Non-Negotiable Product Rules

1. **Each server URL must be unique.**
2. **No multi-user per server URL** (one account/session per server URL entry).
3. Tapping the **profile area in the LHS drawer** must open the server picker.

## Scope

- In scope: mobile app architecture, storage, auth/session handling, SSE behavior, offline storage isolation, deep-link handling, and server-picker UI flow.
- Out of scope: backend API changes (unless needed for compatibility), webapp/mobile design overhaul, and desktop-only behaviors.

## Current Baseline (Observed)

- Single global server URL and session in secure storage.
- Single global axios base URL/session storage behavior.
- Single SQLite database (`jot.db`) for all offline data.
- Drawer profile block is display-only and not pressable.
- Deep links currently enforce one configured server.

## Canonical Server Identity

Server uniqueness uses a **canonical normalized URL** and is **origin-only** for identity (scheme + host + non-default port only).

Canonicalization rules:

1. Trim whitespace.
2. Require `http://` or `https://`.
3. Parse with URL parser.
4. Lowercase scheme + host.
5. Drop path/query/hash for identity (origin-only matching).
6. Normalize default ports as implicit:
   - `http://host:80` -> `http://host`
   - `https://host:443` -> `https://host`
7. Preserve explicit non-default ports (for example `:8080`).
8. Remove trailing slash if present.

Two server entries that normalize to the same canonical origin are duplicates and must not both exist.

Implementation requirement: deep-link server matching, duplicate checks, storage migration, and active-server resolution must all call the same canonicalization helper to avoid drift.

Alignment note:

- Current `webapp/src/utils/deepLink.ts` and `mobile/App.tsx` currently normalize origins with slightly different formatting details (for example lowercase handling and default-port treatment).
- When implementing this spec, update both call sites in lockstep to call the shared helper so the default-port and casing rules above are enforced consistently.

## Data Model Contract

Introduce an account registry keyed by canonical server URL (or stable derived ID):

- `server_url` (canonical, unique)
- `display_name` (optional editable label)
- `last_used_at`
- `cached_profile` (best-effort cached auth profile)

`serverId` contract:

- `serverId` is an opaque, stable identifier for a server entry.
- It may be the canonical URL string or a derived hash/id.
- If derived, the mapping from canonical URL -> `serverId` must be deterministic and persisted.

Secure storage contract:

- Session/profile values are stored in **namespaced per-server SecureStore keys**.
- Do not use raw URL strings directly as long key names; use a stable short suffix (e.g., hash of canonical URL).

There is at most one active server at a time (zero is allowed when the server registry is empty).

## Phase Plan

### Phase 1: Account Registry + Storage Migration

**Goal:** move from single-server globals to server-keyed account storage.

Tasks:

- Add account registry module/context with APIs:
  - `listServers()`
  - `getActiveServer()`
  - `addServer(url)`
  - `switchServer(serverId)`
  - `removeServer(serverId, options?)`
  - `renameServer(serverId, label)`
- Add duplicate prevention on `addServer(url)` using canonical URL.
- `addServer(url)` should return a deterministic structured result with explicit outcomes (for Phase 3 UI messaging/actions):
  - success:
    - `{ success: true, serverId }`
  - failure:
    - `{ success: false, code: 'INVALID_URL', message, retryable: false, details? }` (URL parse/canonicalization failed before network probe)
    - `{ success: false, code: 'DUPLICATE', message, retryable: false, existingServerId }`
    - `{ success: false, code: 'NETWORK_ERROR', message, retryable: true, details? }`
    - `{ success: false, code: 'INVALID_ENDPOINT', message, retryable: false, details? }`
    - `{ success: false, code: 'AUTH_REQUIRED', message, retryable: false, details? }` (server requires auth for discovery/probe endpoint)
    - `{ success: false, code: 'SERVER_ADD_ERROR', message, retryable: false, details? }`
- `removeServer(serverId, options?)` contract must define explicit data-safety behavior for the per-server SQLite DB and offline sync queue:
  - removal of the currently active server must also define post-removal selection behavior:
    - preferred: switch to the most recently used remaining server; otherwise transition to an unauthenticated state with zero active servers.
  - before removal, check unsynced state (`sync_queue` pending count and unsynced local entities in that server DB).
  - default behavior (no override): prevent removal when unsynced data exists and return a typed error result:
    - `{ success: false, code: 'UNSYNCED_DATA', message, retryable: false, pendingCount, canForceRemove: true }`
  - optional forced removal path:
    - `options.forceRemove === true` requires explicit caller confirmation and permanently deletes the server's SQLite DB + queue + account registry entry + namespaced secure storage keys.
  - optional archival path:
    - `options.archiveBeforeRemove === true` moves the server DB to an archive location, records archive metadata in the account registry/context, and removes the active entry without destroying archived data.
  - `options.forceRemove` and `options.archiveBeforeRemove` are mutually exclusive; passing both returns:
    - `{ success: false, code: 'INVALID_REMOVE_OPTIONS', message, retryable: false }`
  - successful result must make side effects observable:
    - `{ success: true, action: 'removed' | 'archived', deletedDb: boolean, archivedDbPath?: string }`
- Add one-time migration from old global keys into first server entry.
- Add one-time offline-data migration from legacy `jot.db` into the first server DB:
  - routine examples: `migrateLegacySqliteToServer(legacyDbPath, serverId)` or `migrateSyncQueueAndNotes(legacyDbPath, targetDbPath)`.
  - invoke from one centralized startup hook and only when migration state is not completed (idempotent via persisted migration marker/version).
  - `addServer(url)` first-server path should call the same centralized hook, not a separate copy, to avoid double migration attempts.
  - migration requirements: create backup, validate schema, atomic copy/import, deduplicate records, and log errors.
  - post-success behavior must be explicit: archive/rename legacy `jot.db` (do not continue using it as active DB) so migration is not repeated.
- Keep backward-safe fallback if migration data is missing/corrupt.

Acceptance:

- Existing single-server users retain access after upgrade.
- Attempting to add duplicate URL is blocked and returns deterministic duplicate result.
- Legacy `jot.db` notes/sync queue are migrated (or safely backed up + skipped with explicit error state if migration fails).

### Phase 2: API/Auth Refactor to Active Server

**Goal:** all network/auth operations resolve against active server context.

Tasks:

- Refactor API client base URL/session resolution to active server.
- Refactor auth restore/login/register/logout/revalidate flows to server-keyed storage.
- Enforce one user/session per server URL:
  - logging in/registering to existing server updates that server’s session/profile entry.
  - no secondary user slot creation for same server URL.
- Ensure unauthorized handling only clears active server session/profile state (never clears other saved servers).

Acceptance:

- Switching active server changes API target immediately.
- Session for server A is never sent to server B.

### Phase 3: LHS Profile-Triggered Server Picker UI

**Goal:** profile area in drawer opens server picker.

Tasks:

- Convert drawer profile section to pressable.
- Implement server picker modal/screen:
  - server list with active indicator
  - switch action
  - add server action
  - optional remove/rename
- Duplicate add behavior:
  - show "already added"
  - offer "switch to existing"
- Keep existing drawer navigation behavior unchanged otherwise.

Acceptance:

- Tap on drawer profile section opens picker reliably.
- Duplicate URL cannot create a second entry.

### Phase 4: Offline Isolation by Server

**Goal:** no offline/sync data bleed between servers.

Recommended implementation:

- Use **one SQLite DB file per server** (preferred over account_id columns for this scope).
- DB filename must be filesystem-safe and derived (e.g., `jot_<hash(canonicalServerUrl)>.db`), never raw URL text.
- Adopt dynamic per-server DB management (option A): open/look up DB handles keyed by canonical-server hash (for example with `openDatabaseAsync`) and route all DB operations through the active server DB handle.
- Remount/rebind SQLite provider (or equivalent DB context) on server switch.
- Ensure all queries touching `notes`, `note_items`, and `sync_queue` use the active server DB handle.
- Ensure sync queue enqueue/dequeue/drain workers run only for the active server DB context.
- Explicitly run the legacy `jot.db` -> per-server DB migration routine from Phase 1 before steady-state per-server routing.

Acceptance:

- Notes/sync queue for server A remain isolated from server B.
- Switching servers never shows other server’s offline notes.
- Legacy single-DB installs either migrate data successfully or preserve a backup + explicit recovery/error state.

### Phase 5: Cache/SSE/Sync Lifecycle on Switch

**Goal:** safe runtime transitions when switching server.

Tasks:

- Define and implement a gated server-switch transaction with explicit ordering:
  1. Enter transition lock (`switchGenerationId`) and block new writes for old server context.
     - reads may continue for old context until commit, but any data handlers must be generation-gated.
  2. Quiesce realtime ingress:
     - set SSE to quiesce state and disconnect old server EventSource.
     - during quiesce, discard or buffer incoming old-generation events (choose one behavior and document it; default recommendation: discard old-generation events).
  3. Handle in-flight API requests:
     - cancel active requests for old server via abort/cancel mechanism.
     - ignore late old-generation responses by generation guard so they cannot mutate new context.
  4. Handle offline sync worker:
     - pause old-server queue drain before context switch.
     - default: do not block switch waiting for upload; keep pending entries in old server DB and resume when switching back.
     - optional mode may allow waiting for drain with timeout + retry prompt before switch commit.
  5. Commit context switch:
     - clear server-scoped React Query caches
     - reset server-scoped auth/user/settings state (do not reset device-global preferences unless explicitly intended)
     - initialize active server context (network + DB handle/provider + account registry state)
     - rebind/remount DB provider/handle before allowing destination-server queries
  6. Resume destination context:
     - reconnect SSE only after destination context is initialized and authenticated
     - resume sync worker for destination server only
- Define error/retry behavior per step:
  - pre-commit failure: abort switch and keep old server active.
  - post-commit initialization failure: keep new server selected but mark degraded state and surface retry action.
  - all retries must remain generation-gated to prevent cross-server mutations.
- Scope query keys by active server key where practical.

Acceptance:

- No stale cross-server UI data after switch.
- SSE reconnects only for active server.
- In-flight old-server responses/events cannot mutate new-server state.

### Phase 6: Deep Links + Auth Entry UX

**Goal:** deep links and auth flows align with multi-server uniqueness rule.

Tasks:

- Deep link handling:
  - deep-link contract: `jot://...?...&server=<encodedServerOrigin>`
  - `server` query param value is an origin-only value: `scheme://host[:port]` (no path/query/hash).
  - `server` value must be URL-encoded in the link and URL-decoded before canonicalization.
  - this matches current behavior in webapp deep-link generation and mobile deep-link parsing/matching.
  - if full server URL/path matching is ever adopted, it must be a coordinated change across:
    - `webapp/src/utils/deepLink.ts` (`buildMobileDeepLink` + origin normalization behavior)
    - `mobile/App.tsx` (`parseDeepLink`, `normalizeServerOrigin`, and server comparison flow)
    - backward compatibility handling for existing origin-only links
  - path-based server identity in deep-link `server` values is currently out of scope.
  - if `server` matches existing canonical URL: switch and continue.
  - if unknown: prompt add/switch flow before protected navigation.
  - if invalid URL: reject with user-facing error.
- Login/Register screens:
  - consume active or selected server from picker/registry.
  - prevent accidental duplicate server entries.

Acceptance:

- Protected deep links route correctly for known servers.
- Unknown-server deep links do not silently route against wrong server.

### Phase 7: Settings + Supporting UX

**Goal:** make server state visible/manageable in user settings where needed.

Tasks:

- Expose current server identity in settings/about surfaces.
- Ensure avatar/profile-icon fetches always use active server base URL.
- Add/adjust i18n keys for server management and duplicate handling.
- Locale requirement: keep mobile locale files in sync under `mobile/src/i18n/locales/*.json` (add new keys in `en.json` first, then mirror to all shipped locales).

Acceptance:

- UI strings complete in required locales.
- Server-specific profile resources resolve correctly post-switch.

### Phase 8: Tests and Validation

**Goal:** prove correctness and prevent regressions.

Required coverage:

- Unit/integration tests for URL canonicalization + duplicate checks.
- Migration test: legacy single-server keys -> registry.
- Auth/session tests across two servers.
- Mobile test and lint gates:
  - `task test-mobile`
  - `task lint-mobile`
- Manual validation:
  - add two unique servers
  - login both
  - switch from drawer profile picker
  - verify isolated notes and queue
  - verify duplicate add blocked
  - verify deep-link server matching behavior

## Agent Execution Notes

- Implement phases in order; do not start DB isolation before account registry exists.
- Keep commits phase-scoped when possible.
- For UI phases, provide screenshot/video artifacts.
- Do not loosen uniqueness rule under any fallback condition.

## Risks and Mitigations

- **Risk:** cross-server data leakage in cache/sync.
  - **Mitigation:** server-scoped DB + query key scoping + switch lifecycle reset.
- **Risk:** migration regressions for existing users.
  - **Mitigation:** one-time idempotent migration with fallback and tests.
- **Risk:** duplicate URL edge-cases.
  - **Mitigation:** central canonicalization helper + exhaustive tests.

## Definition of Done

All phases completed with passing targeted tests and manual verification evidence:

- Multi-server works end-to-end.
- Drawer profile opens server picker.
- Duplicate server URLs are impossible.
- Exactly one user/session per server URL entry.
