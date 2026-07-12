# Design Guide: Mobile Connectivity & Offline Handling

Status: **Living guide** — describes the intended behavior the mobile app should
converge on. Owner: TBD · Target: Jot mobile (`mobile/`)

This is the rationale behind the condensed rules in `mobile/CLAUDE.md` →
*Connectivity & Offline Handling*. When the two disagree, the CLAUDE.md rules
win (they are the enforced summary); update both together.

---

## 1. Purpose

The mobile app is used on phones with unreliable links: dropped signal, captive
portals, a self-hosted server that is briefly down or restarting, cellular
dead zones, and slow/half-open connections. Nearly every "the app froze" or "my
note didn't save" report traces back to a handful of missing principles rather
than a one-off bug. This guide states those principles so new code applies them
by default instead of re-deriving (or violating) them per handler.

The reference implementation of most of this already ships: a local-first SQLite
store, a replay queue, optimistic writes, a server-reachability signal, and
backoff. The open work is the set of places that deviate from it (see §10).

---

## 2. Core principle

**The local SQLite DB + sync queue is the source of truth for the UI. The
network is a background reconciler, never on the critical path of a user
action.**

If the app can satisfy an action locally, the user never waits on the network to
do it. Whether a request succeeds in 50 ms or times out at 5 s must not change
*when* the UI responds — only what happens in the background afterward.

Almost every rule below is a corollary of this one. When unsure, ask: *"Does this
action block the UI on a network round-trip?"* If yes and the action has a local
representation, it's wrong.

---

## 3. The three connectivity states

Treat these as distinct — conflating them is the root cause of the worst bugs.

| State | How it's known | Cost to detect | Correct response |
|---|---|---|---|
| **Device offline** | NetInfo `isConnected` / `isInternetReachable` (`OfflineContext`) | Instant, free | Skip the network entirely; go straight to local + queue. |
| **Server unreachable, device online** | Not observable without trying. Tracked as a best-effort belief in `src/api/serverReachability.ts` (`isServerReachable()`), flipped by request outcomes + SSE. | One failed request (first time) | After the first failure, skip the doomed round-trip and fall back immediately. |
| **Slow / flaky / half-open** | Looks online; a request is accepted but stalls | Only via a timeout | Finite, tiered timeouts + fast fallback to the local path. |

The classic mistake is treating "device online" as "server usable." A device can
have full WiFi while the Jot server is down, restarting, or unroutable. That gap
is exactly what `serverReachability` exists to cover; NetInfo alone cannot.

`serverReachability` defaults to `true` and is re-armed on any successful
response, an SSE stream (re)open, and a device reconnect — so recovery is
detected from several angles even with no user writes in flight.

---

## 4. Operation classes & correct behavior

Different operations have different fallback options, so they get different
rules. The gate `isOnlineWriteAllowed(isConnected)` (in `serverReachability.ts`)
encodes "device connected **and** server believed reachable **and** not in local
mode" for the write paths.

| Class | Examples | Local fallback? | Correct behavior |
|---|---|---|---|
| **Writes** | note/item/label create·update·delete, share, reorder | Yes (queue) | Optimistic local commit + enqueue, return immediately. Gate the network attempt on `isOnlineWriteAllowed(isConnected)`. Roll back only on a *permanent* rejection. |
| **Reads** | note list, note body, labels | Yes (cached data) | Serve local cache immediately; refresh in the background with bounded retries; never block load/refresh on the network. |
| **Auth / one-shot** | login, register, logout, server switch, PAT create/revoke | No | Finite timeout — the longer `DEFAULT_REQUEST_TIMEOUT_MS`, since auth is excluded from the short write budget — + visible pending state + honest error. Optimistic where the local outcome is authoritative (logout). |
| **Uploads** | note images, profile icon | Partial (image queue for note images) | Finite timeout (never `0`), cancellable, fall back to the upload queue where one exists. |

### 4.1 Writes — never block, ever

- Commit optimistically to local state and the DB, enqueue for replay, return.
  The UI reflects the change instantly regardless of connectivity.
- Attempt the network only when `isOnlineWriteAllowed(isConnected)` is true;
  otherwise skip straight to the queue. On a *transient* online failure, catch and fall through
  to the same queue path (`rethrowIfNotQueueable` draws the transient/permanent
  line).
- Surface *permanent* failures (validation 4xx, conflict 409) distinctly and
  immediately — they are real errors, not "saved, syncing." *Transient* failures
  are invisible to the user beyond the ambient "syncing" state.
- Replays must be idempotent (see §8).

### 4.2 Reads — serve stale, refresh quietly

- The list/detail queries read from local SQLite and render instantly; the
  network refresh is a separate background effect, never a precondition for
  showing content.
- Background refresh (`retrySync`) uses bounded attempts + backoff and should
  consult `isServerReachable()` so it fast-fails a known-down server instead of
  burning the full retry budget against it.
- A failed background read is **not** an error dialog — it's a *staleness*
  signal. The user keeps seeing cached data; ideally the UI can show when data
  was last synced (a diagnostic surface exists; a user-facing one is future
  work).

### 4.3 Auth & one-shot ops — bounded, honest, optimistic where safe

- These have no replay queue, so they legitimately touch the network on the
  critical path. That's acceptable **only** with a finite timeout — the longer
  `DEFAULT_REQUEST_TIMEOUT_MS`, since auth is excluded from the short write budget
  — a visible pending state, and a clear terminal error, never a silent
  multi-second freeze or an infinite spinner.
- Be optimistic when the local outcome is authoritative. **Logout** should clear
  the session/profile locally and land on the login screen immediately, firing
  `POST /logout` in the background best-effort (server-side invalidation is
  best-effort regardless; the raw token only ever lived in the client).

### 4.4 Uploads

- Never `timeout: 0`. A stalled upload must become a recoverable error within a
  generous finite cap, not an infinite spinner.
- Provide a cancel affordance for an in-flight upload.
- Where an offline upload queue exists (note images, issue #618), fall back to
  it via `isOnlineWriteAllowed()` like any other write.

---

## 5. Timeouts

- **Finite and tiered. Never `timeout: 0`.**
- **Writes**: the short budget (`WRITE_REQUEST_TIMEOUT_MS`, currently 5 s) —
  short *because* a local fallback is waiting; the timeout is just "how long
  before we queue it." Applied to POST/PATCH/DELETE by the request interceptor
  in `src/api/client.ts` (multipart + auth excluded).
- **Reads / auth**: the longer default (`DEFAULT_REQUEST_TIMEOUT_MS`, currently
  15 s) — no fallback, and they can be legitimately slow.
- The timeout is the **worst case**. In the common "server known-down" case,
  `isServerReachable()` should make the code fall back *immediately*, not after
  the timeout elapses.

---

## 6. Feedback model

The user should always be able to answer three questions without doing anything:

1. **Am I connected?** — one persistent, unobtrusive indicator (offline /
   reconnecting), not a modal.
2. **Is my work safe?** — "saved locally" the instant they act, distinct from
   "synced." They must never wonder whether a note survived.
3. **Did something fail to sync?** — a passive surface (the failed-note badge /
   sync-failures screen), not a blocking dialog.

Rules of thumb:

- An action with a local fallback shows **no spinner** — it's instant.
- An action that must hit the network (auth) shows a **bounded** spinner + a
  terminal error.
- Blocking dialogs are reserved for decisions only the user can make, not for
  waiting on the network.

---

## 7. Recovery & loop safety

- **Re-arm reachability** on any successful response, an SSE (re)open, and a
  device offline→online transition, then drain the queue.
- **Backoff**: every retry uses exponential backoff (start ≥ 1 s, cap 60 s);
  never a tight loop.
- **Re-entrancy**: a sync already in progress is skipped, not queued a second
  time.
- **Cap**: consecutive failures are capped before surfacing an error, so a
  persistently failing server doesn't busy-loop.

(These are the *Sync Loop Safety* rules in `mobile/CLAUDE.md`; connectivity
handling and loop safety are two halves of the same system.)

---

## 8. Idempotency & conflict handling

- Offline-created entities get a **server-valid client ID up front** so the
  queued create is idempotent on replay (a duplicate `id` → 409, treated as
  already-applied — no second copy).
- Writes are **partial/field-level** where possible so a replayed op doesn't
  clobber fields another device changed concurrently.
- Content edits are **version-guarded** (`base_version`); a 409 is *permanent*
  (surface it), a network error is *transient* (queue it). This transient vs.
  permanent split (`rethrowIfNotQueueable` / `isQueueableError`) is the same line
  used everywhere else.

---

## 9. Where this lives in the code

| Concern | Module |
|---|---|
| Device connectivity + queue drain | `src/store/OfflineContext.tsx` |
| Server-reachability belief + write gate | `src/api/serverReachability.ts` (`isServerReachable`, `isOnlineWriteAllowed`) |
| Timeouts + interceptors + reachability wiring | `src/api/client.ts` |
| Sync queue + transient/permanent split | `src/db/syncQueue.ts` (`rethrowIfNotQueueable`, `isQueueableError`) |
| Bounded read retries | `src/utils/retryWithBackoff.ts` (`retrySync`) |
| Optimistic writes + offline fallback | `src/hooks/useNotes.ts`, `useLabels.ts`, `useNoteImages.ts` |
| Local-first read queries | `src/hooks/useOfflineNotes.ts` |
| SSE stream + reconnect | `src/api/events.ts` |
| Diagnostics (developer-facing state) | `src/screens/DiagnosticsScreen.tsx` |

---

## 10. Anti-patterns (with the bugs they caused)

- **Blocking navigation/an action on a network flush** — the original
  unsaved-changes freeze; fixed for the note-editor exit in #693 by navigating
  immediately and flushing in the background when the server is unreachable.
- **`timeout: 0` on uploads** — infinite hang on a half-open server
  (note-image and profile-icon uploads; issue #695).
- **A blocking network call that could be optimistic** — logout waits ~15 s on a
  down server before clearing the local session (issue #696).
- **Awaiting a write, then navigating, with no feedback** — menu/action handlers
  freeze ~5 s with no spinner (issues #697/#698).
- **Unbounded read retries that ignore reachability** — `retrySync` hammers a
  down server for ~67 s (issue #699).
- **Conflating device connectivity with server reachability** — the umbrella
  cause; if you find code branching only on `isConnected` for a *write*, it
  probably wants `isOnlineWriteAllowed()`.

---

## 11. Open work

Tracking issues at the time of writing: #695 (upload timeout/cancel), #696
(logout), #697/#698 (action-handler freezes), #699 (`retrySync` reachability +
attempt cap), #700 (surface reachability/sync-freshness in Diagnostics). A
user-facing "last synced / syncing / sync failed" indicator in the main UI is
noted as future work beyond the diagnostic surface.
