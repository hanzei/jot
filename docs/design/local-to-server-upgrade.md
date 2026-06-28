# Design: Local → Server Sync Upgrade Path

**Status:** Draft / proposal
**Scope:** Mobile app
**Relates to:** epic #511 (serverless local mode) — this is its capstone.

## Summary

Local ("serverless") mode (#511) lets the mobile app run as a single-user,
on-device note store that never talks to a Jot server. This document proposes
the **upgrade path**: letting a user who started in local mode adopt a real Jot
server and push all of their on-device notes, labels, and settings up to it,
then continue as a normal server-backed client.

The epic was deliberately built to make this possible:

- Every local ID (user, note, note item, label) is already a **22-char
  server-format ID**, so local rows can become server rows **without re-keying**.
- The server already **honors client-supplied IDs** on `POST /notes`,
  `POST /labels`, note items, and `/notes/{id}/duplicate`. A local note can be
  created on the server *under its existing ID*.
- The offline **replay engine already exists**: `sync_queue` +
  `OfflineContext.performDrain` already POST/PATCH/DELETE queued ops to a
  server with id-remapping, retries, backoff, and dead-lettering
  (`mobile/src/db/syncQueue.ts`). Local mode currently just *no-ops* it (#514).

So this is mostly **orchestration + identity handling** on top of machinery the
offline path already exercises in production — not a new sync engine.

## Goals

- A user in local mode can connect their device to a Jot server and have all
  local data appear on the server, retaining note/label/item identity.
- The migration is **resumable** on partial failure and never corrupts or loses
  local data.
- After a successful upgrade the app behaves exactly like a normal first-class
  server-backed client.

## Non-goals (this iteration)

- **Merging into an existing, non-empty account.** First iteration targets a
  **newly registered account only**. Even then, emptiness is **verified in
  pre-flight** (Phase 0, `GET /notes`/`GET /labels` return empty) — never
  assumed — because client-supplied IDs are only collision-safe against a
  *confirmed*-empty target. Merging into an account that may already contain
  notes is deferred (see "Future work").
- Multi-device convergence beyond what normal server mode already provides.
- A reverse path (server → local export). That is tracked separately as
  local-mode backup/export.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Target account | **New registration only** | An empty target avoids client-ID collisions; emptiness is **verified in pre-flight** (Phase 0), not assumed, and then the push is a straight replay with IDs preserved. |
| User identity | **Do not adopt the local user ID** | `POST /notes` sets `owner = authenticated user` regardless of the local user ID, so only note/label/item IDs need to survive — and they do. The server-assigned user ID becomes the real one. |
| Post-upgrade local data | **Keep the local DB as the server cache**, but only flip after a clean drain, then background-reconcile | Local rows already carry server-valid IDs and `sync_state='synced'`, so reuse is instant and needs no re-download. Gating on a fully-drained queue (zero dead-letters) closes the data-loss / drift window; a background refetch makes the server canonical right after. |

### Why "keep DB as cache" and not "wipe + re-fetch"

In local mode the *device* is the source of truth; after upgrade the *server*
is. That handoff is the risk:

- **Keep-as-cache** is instant and offline-friendly, but only correct if the
  push was perfect — the server may set fields the client didn't (canonical
  timestamps, ordering/position, label-count caches, normalization). We mitigate
  by (a) only flipping after the queue drains to **zero with no dead-letters**
  and (b) kicking a **background reconcile/refetch** immediately after the flip,
  so any server-side drift self-heals without a blocking reload.
  - **If that post-flip reconcile itself fails** (we are now in server-backed
    mode): retry with backoff like any normal server fetch, and if it keeps
    failing, surface a non-blocking "re-sync" prompt so the cache cannot remain
    silently stale. Because the cache is exactly what we just pushed, a failed
    reconcile degrades to "may be missing server-canonical fields," **not** data
    loss — the next successful reconcile (or a manual pull-to-refresh) repairs
    it.
- **Wipe-and-re-fetch** makes the server canonical immediately but requires a
  full re-download (visible reload, needs connectivity) and is dangerous on
  partial failure: wiping local data that never reached the server would lose
  it. Rejected for the first iteration.

## Proposed flow

Entry point: a **"Connect to a server"** action in Settings, visible only in
local mode (mirrors the existing "Use without a server" link on `LoginScreen`).

### Phase 0 — Pre-flight checks (mandatory; gate seeding and the flip)
No data is moved and the mode is never flipped unless **both** checks pass.
A failure here aborts the upgrade cleanly with the user still in local mode.

- **Server capability / version.** Confirm the target server provides the
  guarantees this flow depends on *before* offering or starting the upgrade:
  client-supplied IDs honored on `POST /notes`, `POST /labels`, and
  `POST /notes/{id}/items`; the expected endpoint shapes; and 409-on-duplicate
  idempotency. If the server is too old or missing a capability, refuse the
  upgrade up front rather than failing mid-migration. (This is a hard
  requirement, not an open question — see "Open questions".)
- **Server emptiness.** On the freshly authenticated account, `GET /notes` and
  `GET /labels` must return empty. A new registration is *expected* to be
  empty, but we verify rather than assume, since client-supplied IDs are only
  collision-safe against a confirmed-empty target. If non-empty, abort (no
  merge support this iteration; see "Future work").

### Phase 1 — Authenticate against the target server
- User enters server URL + chooses **register a new account** (only option this
  iteration), supplies credentials, and we obtain a real session via the normal
  register flow.
- The server assigns its own user ID; we keep it. No user-ID adoption needed
  (see decisions).
- Until the upgrade *completes*, the app is still in local mode — a failure here
  leaves the user exactly where they were.

### Phase 2 — Seed the replay queue from local data
- Walk local SQLite and enqueue a `create` op per entity via the existing
  `enqueueOperation`, in dependency order:
  1. **labels** (`POST /labels`, client ID honored)
  2. **notes** (`POST /notes`, client ID + inline item IDs honored)
  3. **note items** not covered by the inline create, if any
  4. **note↔label links** (`POST /notes/{id}/labels/{label_id}`)
  5. **settings / profile** (`PATCH /users/me`, settings update)
- Because IDs are preserved and the server honors them, this is a straight
  replay with **no id-remapping**.

### Phase 3 — Drain
- Re-enable the sync machinery for this session and hand off to the existing
  `performDrain`. It already handles partial failure, retries, backoff, and
  dead-letters.
- Migration progress = queue depth draining to zero. A mid-way failure is
  **resumable**, not corrupting.

### Phase 4 — Flip to server-backed mode (point of no return)
- Precondition: `sync_queue` empty **and** `dead_letter` empty for this
  migration. If anything dead-lettered, surface it and let the user retry;
  do **not** flip.
- On a clean drain:
  1. Persist the real session via the existing server-context path —
     `initializeServerContext` (`mobile/src/api/client.ts`), the same mechanism
     `AuthContext` uses on a normal server login — so the axios client and SSE
     pick up the authenticated session.
  2. `disableLocalMode()` — drop the on-device local identity record.
  3. Set `isLocalMode = false` (and the synchronous mirror via
     `setLocalModeActive(false)`).
  4. The **same local DB stays** as the server cache.
  5. Kick a background reconcile that reuses the offline read-sync path:
     `reconcileServerNotesScope` (`mobile/src/db/noteQueries.ts`) over
     `GET /notes`, plus a `GET /labels` refetch, then invalidate the React
     Query scopes (`notesLocalQueryScopeKey()`, `labelsQueryKey()` from
     `mobile/src/hooks/queryKeys.ts`) — the same prefetch/invalidate pattern
     `syncQueue.ts` already uses. Reconciling per-scope atomically preserves
     optimistic state instead of wiping. On failure, apply the keep-as-cache
     failure policy above (retry with backoff + a non-blocking re-sync prompt).

## Reused machinery

- `mobile/src/db/syncQueue.ts` — `enqueueOperation`, drain, dead-letter.
- `mobile/src/store/OfflineContext.tsx` — `performDrain`, reconnect handling.
- `mobile/src/store/localMode.ts` — `disableLocalMode`, `setLocalModeActive`,
  the on-device identity record.
- `mobile/src/api/client.ts` — `initializeServerContext` (activates the
  authenticated server session in Phase 4).
- `mobile/src/db/noteQueries.ts` — `reconcileServerNotesScope` (atomic
  server-list → SQLite reconcile, reused for the Phase 4 background refetch).
- `mobile/src/hooks/queryKeys.ts` — `notesLocalQueryScopeKey`, `labelsQueryKey`
  for the post-flip React Query invalidation.
- Server endpoints (all unchanged):
  - writes: `POST /notes`, `POST /notes/{id}/items`, `POST /labels`,
    `POST /notes/{id}/labels/{label_id}`, `PATCH /users/me`, `POST /register`.
  - reads (Phase 0 emptiness check + Phase 4 reconcile): `GET /notes`,
    `GET /labels`.

## Risks / edge cases

- **Network drop mid-migration** → resumable via the queue; the app stays in
  local mode until a clean flip.
- **Dead-lettered op** → block the flip, surface a retry/resolution UX (an MVP
  for this already exists for offline writes).
- **Partial-success migration (note created, label link dead-lettered)** → the
  note exists server-side but is missing its label until the retry/resolution
  path completes, leaving server data incomplete. The flip is blocked while any
  such op sits in `dead_letter`, so the user can't land in server mode with a
  half-linked dataset.
- **Best-effort settings/profile push fails silently** → preferences like
  `note_sort` or `theme` may not reach the server if their push isn't gated on
  the drain (see the open question). Until that's decided, treat a failed
  settings/profile push as a **visible warning**, not a silent drop, so a
  preference can't disappear unnoticed.
- **Large datasets** → drain is incremental; consider a progress indicator
  driven off queue depth.
- **Server-side field divergence** → handled by the post-flip background
  reconcile.
- **Re-running migration** → idempotent by construction (client IDs + server
  409-on-duplicate), but the flow should also guard against a second run once
  local mode is already disabled.

## Open questions

- Do we want a visible **progress UI** (queue depth) or just a spinner + success?
- Should profile/settings push be best-effort (don't block the flip) or part of
  the gated drain?

(The server capability / version check is **not** open — it is a mandatory
pre-flight gate; see Phase 0.)

## Future work

- **Merge into an existing account** (collision strategy: regenerate IDs on 409
  vs. merge rules).
- **Reverse / backup** export of local data to a file.
- **"Switch back to local"** after connecting (likely out of scope — one-way is
  simpler and safer).

## Suggested issue breakdown (mirrors #511's sub-issue structure)

1. "Connect to a server" entry point + new-account registration in local mode
   (Phase 1).
2. Local-data → queue seeding in dependency order (Phase 2).
3. Migration drain orchestration + progress/failure UX (Phase 3).
4. Clean-drain flip to server mode + background reconcile (Phase 4).
