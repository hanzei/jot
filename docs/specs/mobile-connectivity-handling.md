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
| **Device offline** | NetInfo `isConnected` (`OfflineContext`) | Instant, free | Skip the network entirely; go straight to local + queue. |
| **Server unreachable, device online** | Not observable without trying. Tracked as a best-effort belief in `src/api/serverReachability.ts` (`isServerReachable()`), flipped by request outcomes + SSE. | One failed request (first time) | After the first failure, skip the doomed round-trip and fall back immediately. |
| **Slow / flaky / half-open** | Looks online; a request is accepted but stalls | Only via a timeout | Finite, tiered timeouts + fast fallback to the local path. |

The classic mistake is treating "device online" as "server usable." A device can
have full WiFi while the Jot server is down, restarting, or unroutable. That gap
is exactly what `serverReachability` exists to cover; NetInfo alone cannot.

The reverse holds too: "no internet" does not mean "no server". NetInfo's
`isInternetReachable` reports the public internet (Android's `VALIDATED`
capability, or a probe to a Google host on iOS), so it is false on a LAN with no
uplink or a network that filters those hosts, where a self-hosted server still
answers. It is therefore not part of "device offline" (#1266). `OfflineContext`
uses it only to notice a change of network while the device stays connected —
another network, or a captive portal letting the device through — which starts
a reconnect like an offline→online transition (`src/store/networkChange.ts`).
Since `isConnected` does not flip there, the reconnect also publishes the
catch-up resync (`src/store/resyncEvents.ts`) once it has revalidated the
session; otherwise the read caches would stay stale after a portal login.

### 3.1 The server-reachability belief

`isServerReachable()` is one process-global flag, defaulting to `true`. Because
queue drains and read syncs stop while it is `false`, a wrong `false` stops all
syncing, and the flag must never depend on one of those paths to turn back on.

**What sets it to `false`:** only an axios request that gets no response:
connection refused, DNS failure, or a timeout, including the client's own
(§5), or a response that did not come from Jot (§3.2). Any HTTP status from
Jot, 5xx included, proves the server answered and does not set it to `false`.

**What sets it back to `true`:**

| Source | Where |
|---|---|
| Any axios response from Jot (§3.2), of any status | response interceptor, `src/api/client.ts` |
| SSE stream opens, its response from Jot (§3.2) | `open` handler, `src/api/events.ts` |
| SSE message, keepalives included | `message` handler, `src/api/events.ts` |
| Device reconnect, network change while connected, or app foreground | `handleReconnect`, `src/store/OfflineContext.tsx` |
| Server switch (the flag is not per server) | `src/api/client.ts` |

**What reads it, and what each does while it is `false`:**

| Reader | While `false` |
|---|---|
| Queue drain (`performDrain`) | Returns without sending and without rescheduling. |
| Read sync (`retrySync`) | Aborts with `SyncAbortedError('unreachable')`. |
| Note-image upload (`isOnlineWriteAllowed`) | Goes straight to the sync queue (§4.4). |
| Share-sheet user search; empty trash, export and public-link sections (`isOnlineWriteAllowed`) | Search cached users; disable the online-only action. |

Write hooks never read it: every write goes through the outbox (§4.1), and the
drain applies the gate for them.

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
failure count, so a server that keeps failing to answer still reaches the cap.
So does a new write: every save enqueues whatever the connectivity (§4.1), so
it says nothing about the server coming back. It leaves a pending debounce or
backoff timer alone, and resets the count only once retries have paused at the
cap; a timer that only waits for a failed write to come due (§7) is brought
forward to the debounce instead. Only a pass that stops on connectivity charges
the count: a write that fails while the server answers waits on its own (§7). A
write queued while a drain runs requests a rerun, so the finishing drain cannot
strand it by clearing that write's pending timer.

**Reconnect owns the drain while it runs.** `handleReconnect` re-arms the flag
itself and drains after revalidating the session. While it is in progress, any
other drain (a pending timer, a finishing drain's rerun, a resume) returns
without draining or parking, so nothing reaches the server ahead of the
revalidation; the reconnect's own drain covers them.

**Known cost.** If the API times out while the SSE stream stays healthy (an
overloaded server, a proxy timing out only API routes), each keepalive re-arms
the flag and the next request pays its timeout: a drain's replay, or a
note-image upload, which then falls back to the sync queue. That is at most one
stalled request per keepalive interval, against syncing stopping outright.
Nothing the user waits on stalls: a write has already returned. The drain's
failure cap still bounds the replays.
Read syncs that aborted while the flag was `false` are not re-run on the flip;
the open stream kept delivering live events meanwhile, and a full resync on
every flip would repeat an expensive pull every keepalive in exactly that
degraded case.


### 3.2 Telling Jot's responses from anything else

Without the internet check, a captive portal is reached as if it were the
server: a plain-HTTP request is redirected to the portal's login page, which the
HTTP stack follows to a `200` HTML response. Counted as the server answering, it
would mark the server reachable, and the sync queue would delete a write as
landed although it never reached Jot.

So every request carries a fresh random `X-Request-Id`, and a response counts as
Jot's only when it echoes that ID; the server returns a valid incoming ID
verbatim (`server/internal/server/request_id.go`, since v0.15.0). The helpers
are in `src/api/jotResponse.ts`; the checks are:

| Path | A response that does not echo the ID |
|---|---|
| axios response interceptor, `src/api/client.ts` | Becomes an `AxiosError` with no `response`, and the flag goes `false`. Every caller reads that as a transport failure, so a queued write stays queued and a portal's `401` never logs the user out. Logged once per flip to `false`. |
| SSE `open`, `src/api/events.ts` | Torn down and retried with backoff; does not re-arm the flag. react-native-sse passes no response to `open`, so this reads its private `_xhr`; without it the stream is used but `open` does not re-arm (the next message does). |
| `probeServerReachability`, `src/api/client.ts` | `UNREACHABLE`. |
| `probeServerConfig`, `src/api/config.ts` | `null`, like a failed request. |

A reverse proxy that overwrites `X-Request-Id` on responses makes the server
look permanently unreachable; the log line names that cause. HTTPS servers were
never exposed: a portal cannot complete the TLS handshake.

---

## 4. Operation classes & correct behavior

Different operations have different fallback options, so they get different
rules. The gate `isOnlineWriteAllowed(isConnected)` (in `serverReachability.ts`)
encodes "device connected **and** server believed reachable **and** not in local
mode" for the requests that have no outbox row: one-shot actions and note-image
uploads.

| Class | Examples | Local fallback? | Correct behavior |
|---|---|---|---|
| **Writes** | note/item/label create·update·delete, share, reorder, image removal, settings | Yes (queue) | Commit the local edit and its queue row in one transaction, return immediately; the drain sends it (§4.1). |
| **Reads** | note list, note body, labels | Yes (cached data) | Serve local cache immediately; refresh in the background with bounded retries; never block load/refresh on the network. |
| **Auth / one-shot** | login, register, logout, server switch, PAT create/revoke, public link create·re-time·revoke, empty trash, export | No | Finite timeout (`DEFAULT_REQUEST_TIMEOUT_MS`) + visible pending state + honest error. Optimistic where the local outcome is authoritative (logout). |
| **Uploads** | note images, profile icon | Partial (note images fall back to the sync queue) | Finite timeout (never `0`), cancellable, fall back to the sync queue where one exists. |

### 4.1 Writes — never block, ever

**Every write commits its local edit and its queue row in one transaction. The
drain is the only code that sends writes** (a transactional outbox, #1284).

- A write hook calls `enqueueWrite(db, { localApply, op })` (`src/db/syncQueue.ts`):
  one `withSerializedTransaction` applies the edit to SQLite and inserts the
  `sync_queue` row with its keys, then the hook returns. It makes no network
  call, whatever the connectivity. The UI reflects the change instantly.
- Enqueueing kicks the drain (`subscribeToEnqueue`, debounced by
  `ENQUEUE_DRAIN_DEBOUNCE_MS` in `src/store/OfflineContext.tsx` to coalesce a
  burst). The drain's own gates decide whether to send now (§3.1, §7).
- A *permanent* rejection arrives later, from the drain, and is never an error
  from the action itself. Depending on the operation it becomes a failed change
  (the drain dead-letters the op and badges the note) or is undone silently by
  taking the server's state (§8.4). *Transient* failures are invisible beyond
  the ambient "syncing" state.
- So a write checks locally what it can before queueing: a list conversion
  over the item caps throws `NoteConversionCapError` and writes nothing, a label
  rename to a name another label has is refused, creating a label by a name
  the device already knows returns that label (as the server's get-or-create
  does), and the profile form validates the username
  (`getUsernameValidationError`) before the save is queued.
- Settings and profile changes live in the in-memory session, not SQLite: the
  caller applies them there and queues the `PATCH /users/me` with
  `enqueueSettingsUpdate`.
- Local mode keeps the local edit and writes no queue row: there is no server
  to send it to.
- Replays must be idempotent (see §8).

The outbox replaced an online-first pattern, where a hook called the server
itself while `isOnlineWriteAllowed()` held and queued only after a transient
failure (#1284 converted `useUpdateNote`, #1285 the rest). It reverses the
decision in #1261 to keep that path and gate it per note: with the online path
gone, the per-note gate, the fallback copies of each local apply, the short
write timeout, the in-flight bookkeeping and the pending indicators went with
it. Note-image uploads are the remaining online-first write (§4.4).

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
  The server relies on this too: a subscriber that falls too far behind is
  disconnected rather than sent an incomplete stream, so the reconnect resync is
  what recovers the events it missed. On mobile that close is noticed only by the
  stall watchdog (`src/api/events.ts`), so recovery takes up to its timeout.
- A refresh must never roll back this device's own writes; §8.3 has the rules
  for applying a snapshot.
- A failed background read is **not** an error dialog — it's a *staleness*
  signal. The user keeps seeing cached data; ideally the UI can show when data
  was last synced (a diagnostic surface exists; a user-facing one is future
  work).

### 4.3 Auth & one-shot ops — bounded, honest, optimistic where safe

- These have no replay queue, so they legitimately touch the network on the
  critical path. That's acceptable **only** with a finite timeout
  (`DEFAULT_REQUEST_TIMEOUT_MS`), a visible pending state, and a clear terminal
  error, never a silent multi-second freeze or an infinite spinner.
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
- A note-image upload goes online only while `isOnlineWriteAllowed()` holds
  and the note's create has landed, so the tile can show progress and a cancel
  button, and falls back to the sync queue on a transient failure (#618). The
  queued upload is an `uploadImage` row keyed `note:<id>` (#1288): it lands
  behind its note's create, keeps the note protected, and holds its file under
  `pending-image-uploads/`. The drain sends it as multipart with
  `NOTE_IMAGE_UPLOAD_TIMEOUT_MS`, and holds it back while its note's create is
  pending or failed and unreviewed, without holding back the note's other
  ops. A permanent rejection is not a failed change: the upload moves to
  `pending_image_uploads` as an error tile with Retry and Dismiss, or is
  dropped when its note is gone (404/403).

---

## 5. Timeouts

- **Finite and tiered. Never `timeout: 0`.**
- **Queued-write replays**: `QUEUED_WRITE_TIMEOUT_MS` in `src/db/syncQueue.ts`,
  currently 30 s, passed explicitly so the request interceptor leaves it alone.
  A replay has no fallback to hurry toward — it just stays queued — so the
  budget is generous enough for a large write on a slow but working link. It
  is the only timeout an outbox write (§4.1) ever has.
- **Uploads**: `NOTE_IMAGE_UPLOAD_TIMEOUT_MS` in `src/api/images.ts`
  (currently 90 s), long enough for a large file on a slow link.
- **Reads / auth**: the longer default (`DEFAULT_REQUEST_TIMEOUT_MS`, currently
  15 s) — no fallback, and they can be legitimately slow.
- The timeout is the **worst case**. In the common "server known-down" case,
  `isServerReachable()` makes the drain and reads return at once instead of
  waiting it out.

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
- **Cap**: consecutive connectivity failures are capped before surfacing an
  error, so an unreachable server doesn't busy-loop. A write the server keeps
  failing is paced and bounded on its own (below), not by this cap.
- **Queue liveness: FIFO per key**: order matters only between ops that touch
  the same thing, so a write that keeps failing holds back only the writes that
  depend on it (#1283). Each queued op records the keys it touches — `note:<id>`,
  `label:<id>`, `settings` (`sync_queue_keys`, §9). A drain is one pass in
  insertion order:
  - A *global* failure stops the pass without charging the entry: a network
    error with no server response, or 401/408/429. Every entry would fail the
    same way.
  - An *entry-specific* transient failure (a 5xx, or a non-HTTP throw while
    processing the entry) increments its persisted `attempts` counter
    (`sync_queue.attempts`), puts its keys in a **blocked set for that pass**,
    and the pass goes on. A later op that shares a key with the blocked set is
    skipped without being sent, and its keys join the set, so a chain of
    dependent ops stays in order. So an `addLabelToNote` behind a failing
    `createLabel` waits, and so does everything queued behind it for that note;
    a `reorder` waits if any note it names is blocked; a `duplicate` waits for
    its source's queued writes. Writes to other notes drain.
  - Ambiguous failures are decided by a probe (`isGlobalDrainFailureProbed`,
    `GET /about`, through the shared API client so it also updates the
    server-reachability flag). A gateway status (502/503/504) comes from a
    reverse proxy, since Jot's API never returns one; a client-side timeout
    (axios `ECONNABORTED`/`ETIMEDOUT`, no response) may be a request that always
    outlasts `QUEUED_WRITE_TIMEOUT_MS` (or `NOTE_IMAGE_UPLOAD_TIMEOUT_MS`,
    #1211). If the server answers the probe, the failure is entry-specific;
    otherwise it is global. A plain network error is global without a probe.
    Each ambiguous failure is probed, so a server that goes down mid-pass stops
    the pass at the next one.
  - **An op that fails gets its own wait** (#1301): exponential from its
    failure count, within the backoff bounds above (`sync_queue.next_attempt_at`).
    A pass does not send an op still waiting, but puts its keys in the blocked
    set, so its dependents keep waiting and order holds; skipping it is neither
    a failure nor a stop. The app schedules the next pass for the earliest op
    due, and a reconnect or foreground clears every wait, so the queue recovers
    at once after an outage. One failing write therefore does not hold back
    unrelated ones, and does not pause automatic retries: the pass-level
    backoff and its cap are for connectivity failures only, which charge no op.
  - **A broken server costs a bounded number of requests per pass**: a pass
    stops after a few failed sends in a row with no success between them,
    whatever each op's history, and such passes back off as a whole. A few ops
    that always fail cannot block the queue: after their first failure they are
    waiting, and the next pass sends the ops behind them.
  - **A write the server keeps failing reaches the failed-changes review after
    a bounded time** (#1301): an op is dead-lettered, with its last status,
    once it has failed without a break for a day *and* a handful of times
    (`sync_queue.first_failed_at`, on the device clock). Both are needed: time
    alone would give up on an op that failed once before the app sat closed
    for days; attempts alone would turn a short outage into failed changes
    (#1283). The local→server upgrade uses the attempts alone, since the user
    is waiting on its screen. While any write has been failing for more than a
    few minutes, the `syncError` banner shows; its retries go on.
    Short of that, a permanent rejection (non-transient 4xx) dead-letters, and
    so does a non-HTTP processing error once it has recurred `MAX_ENTRY_DRAIN_ATTEMPTS`
    times (counted on its own in `processing_errors`, since `attempts` also
    grows through an outage; status `PROCESSING_ERROR_STATUS`, 0): it happens
    on the device, so a
    retry is unlikely to help, and the queue needs a way past it. A dead-lettered
    `create` drops its note's dependent queued ops rather than 404-ing each one.
    A best-effort op (`markViewed`, `removeImage`) that keeps failing is
    dropped at the same count, as a permanent rejection of one is: the next
    sync reconciles it, and it never holds back its note's edits.
  - A queued image upload (`uploadImage`) follows the same rules, except that
    a non-HTTP error at the cap, or giving up on one the server keeps failing,
    flags it for a manual retry in the gallery instead of dead-lettering it
    (§4.4).

  Dead letters written before #1283 may hold a 5xx, or status 0 for a timeout,
  from when the drain capped every entry-specific failure. They stay for the
  user to resolve rather than going back into the queue: the drain sent the
  note's later ops past them, so replaying one now could overwrite a newer
  edit with an older one.

(These are the *Sync Loop Safety* rules in `mobile/CLAUDE.md`; connectivity
handling and loop safety are two halves of the same system.)

---

## 8. Idempotency & conflict handling

- Offline-created entities get a **server-valid client ID up front** so the
  queued create is idempotent on replay (a duplicate `id` → 409, treated as
  already-applied — no second copy). So a create whose request timed out after
  the server committed it replays as that 409 rather than as a second entity.
  Note-image uploads follow the same rule with a different status:
  `POST /notes/{id}/images` takes an optional `id` form field (the upload's
  client ID), and a repeated ID on the same note returns the existing
  image with 200 (409 if it belongs to another note).
- Writes are **partial/field-level** where possible so a replayed op doesn't
  clobber fields another device changed concurrently.
- Content edits are **version-guarded** (`base_version`); a 409 is *permanent*
  (a failed change, §8.4), a network error is *transient* (stays queued). The
  drain draws this line with `isTransientHttpStatus`.

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

- A write commits **its local edit and its queue row in one transaction**
  (§4.1). Committed separately, a snapshot that lands between the two finds
  nothing queued and replaces the edit, and a process kill between them leaves
  an edit nothing will replay.
- The drain is the only sender, in FIFO order per key (§7): an op is sent only
  after every earlier queued op that touches the same note. With one drain
  pass at a time, the drain has at most one request per note in flight.
- A queue row stays until the drain has applied its response and deleted it in
  one transaction (§8.3), so the note is protected from the moment the edit
  commits until its outcome is in SQLite, across a restart too.

**The base of a queued content edit.** The row of a content save or a
conversion stores the `base_version` the editor was showing (#1277), not a
value resolved when it is sent. An editor
keeps that baseline while it is dirty, so a chain of saves from one editor can
all carry the same base. The chain does not conflict with itself because of
the own-version rule: when the drain lands a version-guarded edit sent at `b`
and the server answers with `b` or `b + 1` (§8.3, `isOwnVersion`), the new
version holds nothing but this device's edit, and in the same transaction the
drain rebases every edit still queued for the note at base `b` onto it
(`rebaseQueuedEdits`). Each step is also kept in memory, per server database
since note ids are unique only within one server's data
(`src/db/ownVersions.ts`): an edit queued afterwards from the same editor
resolves its base through it at enqueue, and the drain resolves a stored base
through it again when it sends, which covers the rows a running pass loaded
before the rewrite. The record need not outlive the process: neither does an
editor's baseline, and the rewritten rows do. A step only ever moves the
version up. A duplicate starts at version 1 locally, like a create,
since that is the version of the server's copy (§8.1); migration 15 resets the
duplicates older builds queued with their source's version. An edit based on any other version is sent as it is, so a real
conflict still gets its 409. Merging at enqueue (§8.5) turns most chains into
one row; the rebase keeps apart what merging cannot: a save queued while the
row before it is being sent, or one behind an interleaved per-user change.

A row queued by an app version from before the outbox has no stored base; the
drain resolves it from the note's local version at send time, as it used to.

### 8.3 Applying server state

Server state reaches the local database two ways: a snapshot (background fetch,
SSE event) and the response to this device's own write.

**Snapshots**

- A **protected** note is one with a queued op, or an unresolved failed change
  (§8.4). A snapshot is not applied to a protected note. The one exception is a
  field only the server owns and no local edit can touch (the public link).
  It does not extend to a note skipped as older than this device's own write
  (below): that write may be the link change itself.
- The protected check and the write happen in **one transaction**. Reading the
  protected set first and writing afterwards lets a write slip in between.
- A snapshot **older than one of this device's writes** is not applied to the
  note that write touched. This covers a list response built before a queued
  write landed and saved after its queue row was removed. Each snapshot writer
  takes a `snapshotMark()` before it fetches; the API client and the drain
  record every note a write landed on (`src/db/snapshotGate.ts`); the save
  skips, and does not prune, a note written after the mark. The mark is a
  local counter kept in memory: a restart drops every snapshot in flight along
  with it.
- The age check does **not** compare `updated_at`. Local edits stamp it from
  the device clock, so against a server timestamp a device whose clock runs
  ahead would refuse newer snapshots; item changes do not bump `version`
  either. A rule that never accepts a lower `version` is also out: after an
  operator restores a server backup it would freeze notes on every device.
- **Known limit:** an SSE payload is built on the server before it reaches the
  device, so its mark is taken on receipt. A payload from another device's
  write, built just before this device's write to the same note landed but
  received after it, still replaces the newer row until the next pull.
- Image uploads and removals bump `updated_at` like item changes (it orders
  notes by "last modified" and tells `note_updated` content changes apart). The
  device that made one gets no SSE echo, so it sets the local row's
  `updated_at` itself: to the image's `created_at` after an upload (the server
  uses the same value), and to the local clock after a removal, whose response
  is a bare 204. Neither moves it backward. This is for ordering only; the age
  check above never reads it.

**Responses to our own writes**

- When **no other op is queued** for the note and it has **no unresolved
  failed change**, apply the response in full: content and version together.
- When **other ops are still queued**, take neither content nor version. The
  local row already holds the later edits, and adopting only the version breaks
  §8.1. The same goes for the item list a check-off or bulk delete returns
  (`setItemsCompleted`, `deleteCompletedItems`): it is applied only under these
  rules, and otherwise the note is pulled once it is no longer protected.
- When the note has an **unresolved failed change**, take neither content nor
  version; per-user fields may be applied (§8.4).
- The check and the write happen in **one transaction**, as for snapshots. A
  later edit queued between the two would otherwise be replaced by the
  response. This relies on §8.2: an edit and its queue row commit together, so
  the check cannot see an edit without its row.
- In the drain, that transaction also **deletes the op's queue row** and
  rebases the note's queued edits (§8.2). There is no moment where a write has
  landed but neither its row nor its applied response records it. A share
  state that needs a follow-up GET is fetched before the transaction opens.

**Convergence.** After a drain that sent anything, pull the notes it touched.
The device does not receive the SSE echo of its own writes, so without the pull
a row that fell behind stays behind until some unrelated sync happens to run.
A pull the server answers with 404/410 tombstones the note through
`applyServerRemoval`, under the snapshot rules above, so a rejected change on a
note gone from the server does not linger as local state.

**Labels.** A label list sync follows the snapshot rule per label: a label with
a queued `createLabel`, `renameLabel` or `deleteLabel` is neither updated nor
pruned, nor brought back after its delete (`getPendingLabelIds`, read in the
write's transaction by `saveServerLabels`). The list the app shows afterwards
is the reconciled store, not the server's raw list.

### 8.4 Failed changes

A dead-lettered op (§7) keeps the user's edit in the local row so "Keep my
version" can recover it.

- The note stays protected for **as long as a dead letter refers to it**. Only
  resolving that dead letter lifts the protection; a later op that succeeds
  does not.
- **No write path may replace the preserved content**: not a snapshot, not the
  response to a later queued write (a pin or colour change), not a later replay.
  Per-user fields from such a response may be applied; content may not.

**Which rejections are failed changes (#1285).** A permanent rejection always
arrives from the drain, after the action returned, so each operation decides
whether its local value is worth a "Keep my version" prompt, which forks the
note's content:

| A permanent rejection of | Becomes |
|---|---|
| Content: `create`, `duplicate`, `convertNoteType`, an `update` with `title` or `content`, `createItem`, an `updateItem` with `text` | A failed change: dead-lettered, the note badged and protected (above). |
| Label entities: `createLabel`, `renameLabel`, `deleteLabel` | A failed change. Resolving it re-reads the server's label list, so the label store drops the rejected name, deletion or create (a failed fetch leaves that to the next label sync). |
| `updateSettings` | A failed change. Once the queue is empty, the session is re-read so the app shows the server's values again (`syncedSettings`). |
| Per-user state: an `update` without `title`/`content` (pin, colour, archive, collapse), `delete`, `restore`, `permanentDelete`, `reorder` | Dropped, and the notes it names pulled: the local change is undone silently. |
| Item structure and completed flags: `deleteItem`, `reorderItems`, `setItemsCompleted`, `deleteCompletedItems`, an `updateItem` without `text` | Dropped and pulled. |
| Label membership and sharing: `addLabelToNote`, `removeLabelFromNote`, `share`, `unshare` (a collaborator leaving included) | Dropped and pulled. A left note is already gone locally; the pull brings it back if the server kept the share. |
| Best effort: `markViewed`, `removeImage` | Dropped without a pull, also once they keep failing transiently (§7); the next sync reconciles them. |

The silent rows are `SERVER_STATE_ON_REJECTION_OPERATIONS` and
`acceptsServerStateOnRejection` in `src/db/syncQueue.ts`; the best-effort ones
`BEST_EFFORT_OPERATIONS`. A 404/410 of a destructive op and a 409 replay of an
op that names what it creates (`create`, `duplicate`, `createItem`, `share`;
`CONFLICT_IDEMPOTENT_OPERATIONS`) stay idempotent successes ahead of this split
(§8). Every other 409 is a real rejection: a version conflict, or a username
already taken.

### 8.5 Merging queued ops

Ops that supersede each other are merged when they are queued, so a long
offline session replays as a few requests and one conflict produces one failed
change.

- **Merge:** consecutive content saves of one note; edits to a note whose
  create is still queued (folded into the create); repeated per-user changes;
  repeated reorders; repeated edits or check-offs of the same item.
- **Do not merge:** opposite pairs (add/remove a label, share/unshare), ops of
  different types, ops on different notes.
- Merge only into the **last** queued op that shares a key with the new one,
  read-only keys included (a queued duplicate copies its source, so an edit
  queued after it stays after it). The order relative to everything else is
  unchanged. A later reorder replaces an earlier one only when it names every
  note (or item) the earlier one did: the server positions only the ids it
  is sent, so a reorder from a filtered view must not drop the moves of the
  notes it leaves out. The merged row takes over the later reorder's keys,
  since every note it names had nothing queued after that row.
- **Folding into a queued create** is the one exception: an edit of the
  fields a create takes (text, colour, pin) is folded into it, past the item
  and label ops behind it, so the server receives one create with the final
  content. Not when an `update` or a conversion is queued after the create, or
  a duplicate of the note: those would see the folded value change under them.
  Not into a create the drain has ever sent (`sync_queue.send_attempted`): one
  whose response was lost may already be on the server, and its replay then
  resolves as already applied (409) without the folded fields.
  A field the create does not take (archive, collapse) stays an `update`.
- **Never merge into a row the drain is sending.** The drain re-reads each
  row and marks it in flight in one serialized transaction just before it
  sends it, so a merge either lands before that read or appends a new row.
  A row the pass loaded but has not reached yet is still merged into; it is
  sent as it stands when the pass gets there.
- Keep **content and per-user fields in separate rows**. Content is
  version-guarded and per-user fields are not; in one request a content
  conflict would take the pin down with it. A body that carries both is not
  merged. A merged content row keeps the `base_version` of the first save it
  absorbed; a row queued before edits stored their base is not merged with
  one that has it.
- Merged item edits keep a re-parent: an `updateItem` whose `parent_id` is
  `null` (unchanged) does not undo the queued row's.

Merging lives in `src/db/queueMerge.ts`, called from `enqueueWrite` inside the
write's transaction.

### 8.6 Local data belongs to one account

The local database and its queue belong to the account that produced them.

- A signed-in user never sees another account's cached notes, and the drain
  never sends another account's queued ops.
- A **deliberate logout** wipes the local data. If there are unsynced or failed
  changes, the confirmation says so first and can be cancelled.
- A **401** keeps the local data, so the same user can sign back in and the
  queue drains. If a different user signs in instead, the first rule applies.

The database records its owner (`account_owner`). Each sign-in checks it
before anything reads the cache or drains the queue, and wipes on a mismatch.
A logout wipe leaves no owner, so the next sign-in wipes again whatever a
write in flight at logout managed to store. A database from before the record
existed is stamped with the next signed-in user rather than wiped.

### 8.7 Version history

When the server keeps note revisions (#1129), a revision of an offline edit is
dated when it synced, not when it was written, and a whole replayed session
from one user becomes one revision. Both are accepted: the client does not send
its own edit times. Merging (§8.5) therefore loses nothing history would keep.

### 8.8 Not implemented yet

| Rule | Issue |
|---|---|
| §8.4 protection lasts until the dead letter is resolved | #1263 |
| §8.3 "take neither content nor version" while other ops are queued. The drain still adopts a response's version without its content when the version can only be its own write's: a create, or a version-guarded edit the server accepted at `base_version` or one above (`saveServerResponseNote`'s `ownVersion`). Merging (§8.5) shortens chains but does not end them: a row from before the outbox resolves its base from the local version, and an editor opened after a restart, while the note still has ops queued, takes its baseline from the row, with no in-memory own-version step left to advance it. Both need the adopted version until they can resolve their base another way. | #1307 |

---

## 9. Where this lives in the code

| Concern | Module |
|---|---|
| Device connectivity + queue drain | `src/store/OfflineContext.tsx` |
| Server-reachability belief + gate for one-shot actions and uploads | `src/api/serverReachability.ts` (`isServerReachable`, `isOnlineWriteAllowed`) |
| Telling Jot's responses apart (request-ID echo, §3.2) | `src/api/jotResponse.ts` |
| Network change while connected | `src/store/networkChange.ts` |
| Timeouts + interceptors + reachability wiring | `src/api/client.ts` |
| Local note rows, snapshot and response writes (§8.1, §8.3) | `src/db/noteQueries.ts`, `src/db/syncQueue.ts` (`saveServerNote`, `saveServerResponseNote`, `getProtectedNoteIds`, `getSnapshotSkipNoteIds`) |
| Failed-change review and resolution (§8.4) | `src/hooks/useSyncFailures.ts` |
| Local-data ownership, logout wipe, unsynced count (§8.6) | `src/db/accountOwner.ts`, `src/store/AccountDataGate.tsx` (wired in `App.tsx`), `src/components/DrawerContent.tsx` |
| Outbox write: local edit + queue rows in one transaction (§4.1) | `src/db/syncQueue.ts` (`enqueueWrite`, `enqueueSettingsUpdate`) |
| Merging queued ops at enqueue; the row in flight (§8.5) | `src/db/queueMerge.ts`, `claimQueueEntry` in `src/db/syncQueue.ts` |
| Own-version steps for queued content edits (§8.2) | `src/db/ownVersions.ts`, `rebaseQueuedEdits` in `src/db/syncQueue.ts` |
| Sync queue + transient/permanent split + FIFO per key (§7) | `src/db/syncQueue.ts` (`isGlobalDrainFailure`, `drainQueue`, `MAX_ENTRY_DRAIN_ATTEMPTS`, `getSyncQueueStats`) |
| Per-operation rejection policy (§8.4) | `src/db/syncQueue.ts` (`SERVER_STATE_ON_REJECTION_OPERATIONS`, `acceptsServerStateOnRejection`, `BEST_EFFORT_OPERATIONS`) |
| What each queued op touches (`note:`/`label:`/`settings` keys, recorded at enqueue and kept by its dead letter); the protected set reads them | `src/db/queueKeys.ts` (`sync_queue_keys`, `dead_letter_keys`) |
| Snapshot gate (own writes landed after a fetch started) | `src/db/snapshotGate.ts`, wired in `src/api/client.ts` |
| Bounded read retries | `src/utils/retryWithBackoff.ts` (`retrySync`) |
| Write hooks (all on the outbox; image uploads go online first, §4.4) | `src/hooks/useNotes.ts`, `useLabels.ts`, `useNoteImages.ts`; settings in `src/screens/settings/` and `NotesListScreen.tsx` (sort) |
| Local-first read queries | `src/hooks/useOfflineNotes.ts` |
| SSE stream + reconnect | `src/api/events.ts` |
| Catch-up resync signal on SSE reconnect | `src/store/resyncEvents.ts` (published by `src/hooks/useSSE.ts`) |
| Diagnostics (developer-facing state) | `src/screens/DiagnosticsScreen.tsx` |

---

## 10. Anti-patterns (with the bugs they caused)

- **Blocking navigation/an action on a network flush** — the original
  unsaved-changes freeze; fixed for the note-editor exit in #693 by navigating
  immediately and flushing in the background when the server is unreachable.
  Since #1284 the editor's saves go through the outbox, so the exit never
  waits and its Retry/Discard prompt is gone: a rejected save is a failed
  change on the note.
- **`timeout: 0` on uploads** — infinite hang on a half-open server
  (note-image and profile-icon uploads); fixed in #695 by giving both a
  generous but finite timeout and, for note images, a cancel button on the
  in-flight gallery tile that aborts the request.
- **A blocking network call that could be optimistic** — logout used to wait
  ~15 s on a down server before clearing the local session (issue #696); fixed in
  #706 by clearing the local session/profile immediately and firing `POST /logout`
  in the background best-effort.
- **Awaiting a write, then navigating, with no feedback** — menu/action handlers
  froze ~5 s with no spinner. #697 (the note editor's overflow menu) and #698
  (the label picker and drawer label actions) papered over it with pending
  indicators and row spinners shown while the write's online attempt ran.
  #1285 removed the cause instead: every write is a local transaction plus a
  queue row, so the action returns at once and the indicators are gone.
- **Trying the network first and queueing on failure** — the online path a
  write hook took before the outbox needed a short timeout to fall back
  quickly, a copy of every local apply for the fallback, a per-note gate so it
  could not overtake a queued edit (#1261), and still raced queued writes it
  did not know about. Fixed in #1284/#1285 by making the drain the only
  sender (§4.1).
- **Unbounded read retries that ignore reachability** — `retrySync` used to
  hammer a down server for ~67 s; fixed in #699 by consulting
  `isServerReachable()` and capping `SYNC_RETRY_MAX_ATTEMPTS` at 2 (~31 s
  worst case, near-immediate on a known-down server).
- **Conflating device connectivity with server reachability** — the umbrella
  cause; code branching only on `isConnected` for a *write* should be going
  through the outbox instead, and for a one-shot action it wants
  `isOnlineWriteAllowed()`.
- **Breaking a FIFO queue drain on any transient error with no per-entry cap** —
  one reproducibly-failing entry (persistent 5xx, or a non-HTTP throw
  misclassified as transient) wedged the head and silently starved every later
  write (issue #714); first fixed by charging a per-entry `attempts` counter
  and dead-lettering an entry once it hit `MAX_ENTRY_DRAIN_ATTEMPTS`.
- **Dead-lettering an op the server never rejected** — that cap turned any
  server outage longer than about 30 s into "couldn't be saved" changes with
  no retry, for edits that were fine; fixed in #1283 by draining FIFO per key,
  so a failing op holds back only the ops that depend on it and stays queued.
