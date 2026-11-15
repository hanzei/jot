# Design Guide: Mobile Connectivity & Offline Handling

Status: **Living guide** — describes the intended behavior the mobile app should
converge on. Owner: TBD · Target: Jot mobile (`mobile/`)

This is the rationale behind the condensed rules in `mobile/CLAUDE.md` →
*Connectivity & Offline Handling*, *Local Data Consistency* and *Sync Loop
Safety*. When the two disagree, the CLAUDE.md rules
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
backoff. The open work is the set of places that deviate from it (see §8.8
and §10).

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

**Drain on re-arm.** A drain that returns early because the flag is `false`
parks: its backoff chain ends there. A flip from `false` to `true` resumes a
parked drain, and does nothing when no drain parked. Anything that schedules or
runs a drain itself clears the park, so the flip never shortcuts a pending
backoff timer and never drains past the failure cap. The flip also keeps the
failure count, so a write that keeps failing still reaches the cap. A write
queued while a drain runs requests a rerun, so the finishing drain cannot strand
it by clearing that write's pending timer.

**Reconnect owns the drain while it runs.** `handleReconnect` re-arms the flag
itself and drains after revalidating the session. While it is in progress, any
other drain (a pending timer, a finishing drain's rerun, a resume) returns
without draining or parking, so nothing reaches the server ahead of the
revalidation; the reconnect's own drain covers them.

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
- Attempt the network only when `isOnlineWriteAllowed(isConnected)` is true
  *and the note has no queued op* (§8.2);
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
- What a refresh may write, and what it must leave alone, is §8.3: a note with
  an unsynced local change is not overwritten, and neither is a row newer than
  the snapshot.
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
  Logout also wipes the local data, and its confirmation names unsynced
  changes when there are any (§8.6). That check is local, so it does not put
  the network on the path.
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
   "synced." They must never wonder whether a note survived. (One known
   gap: an edit whose online request is still in flight when the app is
   killed; §8.2.)
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
  already-applied — no second copy). Note-image uploads are the exception:
  `POST /notes/{id}/images` takes no client ID, so an upload whose response was
  lost after the server stored it is replayed as a second image. Accepted until
  the endpoint has an idempotency key.
- Writes are **partial/field-level** where possible so a replayed op doesn't
  clobber fields another device changed concurrently.
- Content edits are **version-guarded** (`base_version`); a 409 is *permanent*
  (surface it), a network error is *transient* (queue it). This transient vs.
  permanent split (`rethrowIfNotQueueable` / `isQueueableError`) is the same line
  used everywhere else.

The rest of this section is about consistency: what the local copy of a note
means, and which writes may change it. §3–§7 decide *when* to talk to the
server; these rules decide what the device may believe afterwards. They are the
target. §8.8 lists where the code does not follow them yet.

### 8.1 What the local note means

A local note row is the last server state this device applied, plus the local
edits the server has not confirmed yet.

- **`version` is the server version of the content in the row.** The two are
  written together or not at all. A row must never hold a version newer than
  its content (the next edit would pass the server's `base_version` check and
  overwrite a change the user never saw) or older than it (the next edit would
  get a conflict against the device's own earlier write).
- **`base_version` therefore means "the version of the text the user was
  looking at".** That is the only reading under which a 409 is a real conflict.

### 8.2 Writes to one note stay in order

Writes to the same note reach the server in the order the user made them.

- A write goes out online only when the note has **no queued op**. If it has
  one, the write is queued behind it. This is the pending-create rule (#475)
  applied to every queued op, not only a queued create.
- The drain is the only sender of queued ops, in FIFO order.
- **At most one request per note is in flight**, counting online sends and the
  drain's sends alike. A write made while another write to the same note is in
  flight is queued, and the drain does not send an op for that note until the
  in-flight request has finished. The "no queued op" check alone does not give
  the order: two writes can both pass it while neither has a queue row.
- A write that goes to the queue commits **its local edit and its queue row in
  one transaction**. Committed separately, a snapshot that lands between the
  two finds nothing queued and replaces the edit.

Without this, a queued save replays after a newer online save and replaces it
(the drain stamps the replay with the current local version, so the server
accepts it), or the online save is sent with a version the replay has just made
stale and is rejected as a conflict with itself.

**Known limit.** An online write has no queue row while its request is in
flight. The in-flight marker lives in memory, so it protects the note (§8.3)
only while the app runs. If the app is killed in that window, the edit is in
SQLite but nothing will replay it, and the next server snapshot replaces it. Closing this means
writing the queue row in the same transaction as the local edit and sending
everything through the drain (a transactional outbox). That is not planned
yet; revisit it when background sync is.

### 8.3 Applying server state

Server state reaches the local database two ways: a snapshot (background fetch,
SSE event) and the response to this device's own write.

**Snapshots**

- A **protected** note is one with a queued op, a write in flight (§8.2), or
  an unresolved failed change (§8.4). A snapshot is not applied to a protected note. The one exception is a
  field only the server owns and no local edit can touch (the public link).
- The protected check and the write happen in **one transaction**. Reading the
  protected set first and writing afterwards lets a write slip in between.
- A snapshot **older than the local row** is not applied. Compare `updated_at`:
  item changes do not bump `version`. An equal `updated_at` is applied, since
  some changes (images) leave it alone. This covers a list response built
  before a queued write landed and saved after its queue row was removed.
- **Known limit:** because image changes leave `updated_at` alone, a snapshot
  built before an image upload and saved after it ties with the local row and
  replaces the newer image list. The image disappears from the local cache
  until the next sync; the server copy is unaffected. Keeping the local images
  on a tie is not the fix: a remote image removal whose SSE event was missed
  would then never apply. Closing this needs a server change marker that
  covers images.

**Responses to our own writes**

- When **no other op is queued** for the note and it has **no unresolved
  failed change**, apply the response in full: content and version together.
- When **other ops are still queued**, take neither content nor version. The
  local row already holds the later edits, and adopting only the version breaks
  §8.1.
- When the note has an **unresolved failed change**, take neither content nor
  version; per-user fields may be applied (§8.4).
- The check and the write happen in **one transaction**, as for snapshots. A
  later edit queued between the two would otherwise be replaced by the
  response. This relies on §8.2: an edit and its queue row commit together, so
  the check cannot see an edit without its row.

**Convergence.** After a drain that sent anything, pull the notes it touched.
The device does not receive the SSE echo of its own writes, so without the pull
a row that fell behind stays behind until some unrelated sync happens to run.

### 8.4 Failed changes

A dead-lettered op (§7) keeps the user's edit in the local row so "Keep my
version" can recover it.

- The note stays protected for **as long as a dead letter refers to it**. Only
  resolving that dead letter lifts the protection; a later op that succeeds
  does not.
- **No write path may replace the preserved content**: not a snapshot, not the
  response to a later online write (a pin or colour change), not a later replay.
  Per-user fields from such a response may be applied; content may not.

### 8.5 Merging queued ops

Ops that supersede each other are merged when they are queued, so a long
offline session replays as a few requests and one conflict produces one failed
change.

- **Merge:** consecutive content saves of one note; edits to a note whose
  create is still queued (folded into the create); repeated per-user changes;
  repeated reorders; repeated edits or check-offs of the same item.
- **Do not merge:** opposite pairs (add/remove a label, share/unshare), ops of
  different types, ops on different notes.
- Merge only into the **last** queued op for that note, so the order relative
  to everything else is unchanged. Folding into a queued create is the one
  exception.
- Never merge into a row the drain is sending.
- Keep **content and per-user fields in separate rows**. Content is
  version-guarded and per-user fields are not; in one request a content
  conflict would take the pin down with it.

### 8.6 Local data belongs to one account

The local database and its queue belong to the account that produced them.

- A signed-in user never sees another account's cached notes, and the drain
  never sends another account's queued ops.
- A **deliberate logout** wipes the local data. If there are unsynced or failed
  changes, the confirmation says so first and can be cancelled.
- A **401** keeps the local data, so the same user can sign back in and the
  queue drains. If a different user signs in instead, the first rule applies.

### 8.7 Version history

When the server keeps note revisions (#1129), a revision of an offline edit is
dated when it synced, not when it was written, and a whole replayed session
from one user becomes one revision. Both are accepted: the client does not send
its own edit times. Merging (§8.5) therefore loses nothing history would keep.

### 8.8 Not implemented yet

| Rule | Issue |
|---|---|
| §8.2 a write to a note with a queued op or a write in flight is queued behind it; local edit and queue row commit together | #1261 |
| §8.3 protected check in the write's transaction; refusing older snapshots | #1265 |
| §8.4 protection lasts until the dead letter is resolved | #1263 |
| §8.5 merging queued ops | #1268 |
| §8.3 "take neither content nor version" while other ops are queued. Until queued ops are merged, a chain of queued edits to one note would conflict with itself, so the drain still adopts a response's version without its content when the version can only be its own write's: a create, or a version-guarded edit the server accepted at `base_version` or one above (`saveServerResponseNote`'s `ownVersion`). Remove the exception with #1268. | #1268 |
| §8.6 account ownership, logout wipe and warning | #1264 |

---

## 9. Where this lives in the code

| Concern | Module |
|---|---|
| Device connectivity + queue drain | `src/store/OfflineContext.tsx` |
| Server-reachability belief + write gate | `src/api/serverReachability.ts` (`isServerReachable`, `isOnlineWriteAllowed`) |
| Timeouts + interceptors + reachability wiring | `src/api/client.ts` |
| Local note rows, snapshot and response writes (§8.1, §8.3) | `src/db/noteQueries.ts`, `src/db/syncQueue.ts` (`saveServerNote`, `saveServerResponseNote`, `getProtectedNoteIds`) |
| Failed-change review and resolution (§8.4) | `src/hooks/useSyncFailures.ts` |
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
