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

### 3.1 The server-reachability belief

`isServerReachable()` is one process-global flag, defaulting to `true`. Because
writes, queue drains and read syncs all stop while it is `false`, a wrong
`false` stops all syncing, and the flag must never depend on one of those paths
to turn back on.

**What sets it to `false`:** only an axios request that gets no response:
connection refused, DNS failure, or a timeout, including the client's own
(`WRITE_REQUEST_TIMEOUT_MS` is 5 s). Any HTTP status, 5xx included, proves the
server answered and does not set it to `false`.

**What sets it back to `true`:**

| Source | Where |
|---|---|
| Any axios response, of any status | response interceptor, `src/api/client.ts` |
| SSE stream opens | `open` handler, `src/api/events.ts` |
| SSE message, keepalives included | `message` handler, `src/api/events.ts` |
| Device reconnect or app foreground | `handleReconnect`, `src/store/OfflineContext.tsx` |
| Server switch (the flag is not per server) | `src/api/client.ts` |

**What reads it, and what each does while it is `false`:**

| Reader | While `false` |
|---|---|
| Writes (`isOnlineWriteAllowed`) | Commit locally and enqueue without trying the network. |
| Queue drain (`performDrain`) | Returns without sending and without rescheduling. |
| Read sync (`retrySync`) | Aborts with `SyncAbortedError('unreachable')`. |
| Note editor exit, share-sheet user search, pending-action indicator, export and public-link sections | Leave without awaiting the save, search cached users, skip the pending bar, disable the online-only action. |

**Re-arm guarantee.** While the flag is `false` and the device is online, it
turns back on within one SSE keepalive interval (30 s) if the stream is open.
If the stream is down, its own reconnect backoff (capped at 60 s) acts as the
probe, and the reconnect's `open` re-arms the flag. Neither path depends on a
write, drain or read getting through. Before #1217, keepalives did not re-arm the
flag, so one write timing out on a slow link while the stream stayed healthy
parked all syncing until the app was backgrounded (the same failure #1206 hit
with 502s).

SSE re-arms only from a stream opened for the current server: after a server
switch, the old server's stream says nothing about the new one.

**Drain on re-arm.** A flip from `false` to `true` schedules a queue drain,
because the drain's backoff chain ended when it returned early. The flip does
not reset the drain's failure count, and does not shortcut a pending backoff
timer, so a write that keeps failing still reaches the failure cap. During a
reconnect or foreground, `handleReconnect` re-arms the flag itself and drains
after revalidating the session, so the flip does not schedule a second drain.

**Known cost.** If the API times out while the SSE stream stays healthy (an
overloaded server, a proxy timing out only API routes), each keepalive re-arms
the flag and the next write pays one `WRITE_REQUEST_TIMEOUT_MS` before falling
back to the queue: at most one stalled write per keepalive interval, against
syncing stopping outright. The drain's failure cap still bounds the replays.
Read syncs that aborted while the flag was `false` are not re-run on the flip;
the open stream kept delivering live events meanwhile, and a full resync on
every flip would repeat an expensive pull every keepalive in exactly that
degraded case.

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
| **Auth / one-shot** | login, register, logout, server switch, PAT create/revoke, public link create·re-time·revoke | No | Finite timeout — the longer `DEFAULT_REQUEST_TIMEOUT_MS`, since auth is excluded from the short write budget — + visible pending state + honest error. Optimistic where the local outcome is authoritative (logout). |
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
- Background refresh is triggered by more than the `isConnected` flip. SSE is a
  live stream with no backfill, so events emitted while it was down (e.g. the app
  was backgrounded, which tears the stream down) never arrive. On SSE **reconnect**
  the read caches (notes, labels, users) run a one-shot catch-up resync via the
  `resyncEvents` bus (`src/store/resyncEvents.ts`), published by `useSSE` on every
  reconnect (not the first connect — that's covered by the mount-time sync). This
  closes the gap a bare foreground leaves: foregrounding on a stable network does
  not flip `isConnected`, so the `isConnected`-keyed refresh alone would miss it.
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
- **Public links** (share screen) are offered only while
  `isOnlineWriteAllowed()` holds; otherwise the section says a connection is
  needed instead of queueing. The link is server-owned and shared by everyone
  with access, so there is no meaningful optimistic local state, and a queued
  revoke would leave the URL working for an unknown time. A success writes the
  server's answer to the note's cached `public_link`.

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
- **Queued-write replays**: a longer budget (`QUEUED_WRITE_TIMEOUT_MS` in
  `src/db/syncQueue.ts`, currently 30 s), passed explicitly so the interceptor
  leaves it alone. A replay has no fallback to hurry toward — it just stays
  queued — and a replay that times out while the server answers is charged
  toward dead-lettering (§7, Queue liveness), so the short online budget would
  dead-letter a large write on a slow but working link.
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
- **At most two top banners** (`useTopBanners`): one *status* and the
  *failed changes*. States overlap — an outage is usually also a stalled sync
  — so only the most relevant status is shown: offline → session rejected
  (`revalidation`, the cause when it coincides with the others) → server
  unreachable (`sseReconnect`) → sync keeps failing (`syncError`). The status
  is one banner whose content changes, not one banner per status. Below it,
  "N changes couldn't be saved — Review" shows whatever the connection state,
  until dismissed; a note's own failed-change bar takes over after that.

---

## 7. Recovery & loop safety

- **Re-arm reachability** on any response, an SSE (re)open or message, a
  device offline→online transition, and an app foreground, then drain the queue
  (§3.1).
- **Catch up reads on SSE (re)open.** In addition to re-arming reachability and
  draining the (outgoing) queue, an SSE reconnect publishes a one-shot resync
  (`resyncEvents`) that re-pulls the read caches (notes, labels, users), since any
  live event missed while the stream was down is never re-delivered. The
  heaviest path (notes) guards against a re-entrant sync per the loop rules below.
- **Backoff**: every retry uses exponential backoff (start ≥ 1 s, cap 60 s);
  never a tight loop.
- **Re-entrancy**: a sync already in progress is skipped, not queued a second
  time.
- **Cap**: consecutive failures are capped before surfacing an error, so a
  persistently failing server doesn't busy-loop.
- **Queue liveness (head-of-line safety)**: the drain is strict FIFO, so the
  failure cap above protects CPU/network but *not* queue liveness — a single
  entry that reproducibly fails (a server that 5xx's one payload forever, or a
  non-HTTP error thrown while processing a corrupted body) would otherwise wedge
  the head and starve every later write. Each entry therefore carries a
  persisted `attempts` counter (`sync_queue.attempts`,
  `pending_image_uploads.attempts`). A *global* connectivity failure (a network
  error with no server response, or 401/408/429) stops the drain without charging the head entry; an
  *entry-specific* failure (a 5xx, or a non-HTTP processing throw) charges it.
  A gateway status (502/503/504) is decided by a probe (`isGlobalDrainFailureProbed`):
  Jot's API never returns one, so it comes from a reverse proxy, either because
  the Jot server is down (the probe gets no answer → global, so an outage does
  not dead-letter every queued change) or because this one request keeps
  timing out (the server answers the probe → charged as usual). A client-side
  timeout (axios `ECONNABORTED`/`ETIMEDOUT`, no response) is decided by the
  same probe: a write that always outlasts `QUEUED_WRITE_TIMEOUT_MS` (or an
  upload that outlasts `NOTE_IMAGE_UPLOAD_TIMEOUT_MS`) while the server answers
  is charged, so it dead-letters at the cap instead of wedging the queue
  (#1211). A plain network error (no response, not a timeout) is global
  without a probe. The probe (`GET /about`) goes through the shared API client,
  so its outcome also updates the server-reachability flag like any request.
  Once an entry has failed `MAX_ENTRY_DRAIN_ATTEMPTS` times it is **dead-lettered
  and the drain continues past it** (`#492`'s dead-letter table gains the op, the
  note is flagged `sync_state = 'failed'`), so unrelated later writes drain. A
  dead-lettered `create` also drops its note's dependent queued ops rather than
  404-ing each one. (A server that keeps answering 500 to every request can
  still dead-letter the head after the cap even though the op was fine —
  accepted, since the op is preserved and recoverable via the failed-changes
  review flow.)

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
| Sync queue + transient/permanent split + head-of-line dead-lettering | `src/db/syncQueue.ts` (`rethrowIfNotQueueable`, `isQueueableError`, `isGlobalDrainFailure`, `MAX_ENTRY_DRAIN_ATTEMPTS`, `getSyncQueueStats`) |
| Bounded read retries | `src/utils/retryWithBackoff.ts` (`retrySync`) |
| Optimistic writes + offline fallback | `src/hooks/useNotes.ts`, `useLabels.ts`, `useNoteImages.ts` |
| Local-first read queries | `src/hooks/useOfflineNotes.ts` |
| SSE stream + reconnect | `src/api/events.ts` |
| Catch-up resync signal on SSE reconnect | `src/store/resyncEvents.ts` (published by `src/hooks/useSSE.ts`) |
| Diagnostics (developer-facing state) | `src/screens/DiagnosticsScreen.tsx` |

---

## 10. Anti-patterns (with the bugs they caused)

- **Blocking navigation/an action on a network flush** — the original
  unsaved-changes freeze; fixed for the note-editor exit in #693 by navigating
  immediately and flushing in the background when the server is unreachable.
- **`timeout: 0` on uploads** — infinite hang on a half-open server
  (note-image and profile-icon uploads); fixed in #695 by giving both a
  generous but finite timeout and, for note images, a cancel button on the
  in-flight gallery tile that aborts the request.
- **A blocking network call that could be optimistic** — logout used to wait
  ~15 s on a down server before clearing the local session (issue #696); fixed in
  #706 by clearing the local session/profile immediately and firing `POST /logout`
  in the background best-effort.
- **Awaiting a write, then navigating, with no feedback** — menu/action handlers
  freeze ~5 s with no spinner; fixed in #697 for the note-editor's own
  overflow-menu actions (move to trash, restore, delete-forever, convert,
  share, and the "Manage labels" entry that opens the label picker) by showing
  a pending indicator while the server is reachable and skipping it (the write
  already resolves via the local/queue path) when it's known unreachable. The
  same class of bug on the label-picker screen's own actions (creating,
  renaming, deleting a label) was a different surface, fixed in #698 by
  surfacing a spinner on the affected row/button (drawer label create/rename
  modals, the deleted label's row, and the label-picker toggle/add controls)
  instead of leaving them to sit silently for the write timeout.
- **Unbounded read retries that ignore reachability** — `retrySync` used to
  hammer a down server for ~67 s; fixed in #699 by consulting
  `isServerReachable()` and capping `SYNC_RETRY_MAX_ATTEMPTS` at 2 (~31 s
  worst case, near-immediate on a known-down server).
- **Conflating device connectivity with server reachability** — the umbrella
  cause; if you find code branching only on `isConnected` for a *write*, it
  probably wants `isOnlineWriteAllowed()`.
- **Breaking a FIFO queue drain on any transient error with no per-entry cap** —
  one reproducibly-failing entry (persistent 5xx, or a non-HTTP throw
  misclassified as transient) wedged the head and silently starved every later
  write (issue #714); fixed by charging a per-entry `attempts` counter for
  entry-specific failures (not global connectivity ones) and dead-lettering +
  continuing past an entry once it hits `MAX_ENTRY_DRAIN_ATTEMPTS`.
