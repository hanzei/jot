# Mobile Connectivity & Offline Handling

What the mobile app (`mobile/`) must do when the network or the server is not
there, and what its local data may hold afterwards. `mobile/CLAUDE.md` carries
the same rules in short; change both together.

## How to read this

Every rule here is an **outcome**: what the user sees, or what the local data
may hold. Each comes with its reason, so you can tell when a change keeps it.

- The code may meet a rule any way it likes. "Currently" notes and §9 say
  where a rule is met today, not how it must be met.
- If meeting a rule seems to need one more special case, or code meets a rule's
  purpose but not its wording, raise it as a design question (in the PR or an
  issue). Do not add the special case, and do not rewrite working code to
  match the wording.
- History lives in git and the linked issues, not here.

---

## 1. Purpose

Phones lose signal, sit behind captive portals, and talk to a self-hosted
server that may be restarting. Whatever the link does, the app must keep
working on local data, never lose an edit, and never show data that is wrong
rather than merely old.

## 2. Core principle

**The local SQLite database and the sync queue are the UI's source of truth.
The network is a background reconciler, never on the path of a user action.**

Whether a request takes 50 ms or times out, the UI responds at the same moment;
only what happens in the background differs. An action that has a local
representation never waits on the network.

---

## 3. Connectivity states

Three states, treated as different, because conflating them caused the worst
bugs:

| State | How the app knows | What it does |
|---|---|---|
| **Device offline** | NetInfo `isConnected` | Skips the network entirely. |
| **Online, server not answering** | The reachability flag (§3.1) | Skips requests that would fail, without waiting for a timeout. |
| **Slow or half-open** | Only a timeout | Finite timeouts (§5); nothing the user waits on. |

- **"Device online" is not "server usable"**: Wi-Fi can be fine while the server
  is down.
- **"No internet" is not "no server"** either: on a LAN with no uplink, NetInfo's
  `isInternetReachable` is false while a self-hosted server answers. So it never
  decides "offline" (#1266).
- **A move to another network while connected**, or a captive portal letting
  the device through, counts as a reconnect: a server that did not answer may
  answer now.

### 3.1 Whether the server answers

One flag, `isServerReachable()`, holds the app's belief that the server
answers. It starts `true`, and is not per server: a server switch resets it.

- **It goes `false`** only when a request gets no answer from Jot: no response,
  a timeout, or a response that is not Jot's (§3.2). Any HTTP status from Jot,
  5xx included, proves the server answered.
- **It goes `true`** on any response from Jot, an SSE stream opening or any SSE
  message (keepalives included), a reconnect (§3), an app foreground, and a
  server switch.
- **While it is `false`**, the queue drain and read syncs stop, one-shot actions
  (§4.3) are disabled, and note images go straight to the queue (§4.4).

**Required outcomes:**

- **Nothing that stops while the flag is `false` may be what turns it back on.**
  Otherwise one wrong `false` stops all syncing for good.
- **The flag recovers on its own.** With the stream open, within one keepalive
  interval (30 s). With the stream down, through the stream's own reconnects.
  After a reconnect, queued changes should start syncing within a few seconds
  of the network becoming usable (#1309).
- **When it recovers, a drain that stopped on it resumes**, without skipping a
  pending backoff or resetting the failure count.
- **A reconnect revalidates the session before the queue drains.**
- **A stream from before a server switch says nothing** about the new server.

Accepted cost: if the API times out while the stream stays healthy, each
keepalive re-arms the flag and the next request pays its timeout. That is at
most one stalled background request per keepalive, against syncing stopping
outright. Read syncs that stopped are not re-run on every flip, since that would
repeat a full pull every keepalive in exactly that degraded case.

### 3.2 Telling Jot's responses from anything else

A captive portal answers a plain-HTTP request with its own login page and a
`200`. Counted as the server's, it would mark the server reachable and make the
drain delete a write that never arrived.

**Required outcome: a response counts as Jot's only when it echoes the request's
`X-Request-Id`.** Every request carries a fresh one, and the server returns it
(since v0.15.0). A response that does not echo it is treated as no response.

- Currently: the `api` instance checks this; a request that bypasses it (the SSE
  stream, a probe on its own axios call) uses `src/api/jotResponse.ts`.
- A reverse proxy that overwrites `X-Request-Id` makes the server look
  unreachable forever; the log line names that cause.

---

## 4. Kinds of operation

| Kind | Examples | Rule |
|---|---|---|
| **Writes** | note, item and label changes, share, reorder, image removal, settings | Local first, through the queue (§4.1). |
| **Reads** | note list, note, labels | Local first, background refresh (§4.2). |
| **One-shot** | login, logout, server switch, PATs, public links, empty trash, export | On the network, bounded (§4.3). |
| **Uploads** | note images, profile icon | Bounded and cancellable; note images fall back to the queue (§4.4). |

### 4.1 Writes never block

**Every write commits its local edit and its queue row in one transaction, and
returns. Only the drain sends writes** (a transactional outbox, #1284).

- The UI shows the change at once, whatever the connectivity, and never shows a
  pending state for a write.
- A **permanent rejection arrives later, from the drain**, never as an error from
  the action. It becomes a failed change or is undone silently (§8.4).
  *Transient* failures show only as the ambient "syncing" state.
- So **check locally what can be checked before queueing**: item caps on a
  conversion, a label name that is taken, a username's format.
- **Local mode** keeps the local edit and queues nothing; there is no server.
- Currently: `enqueueWrite` (`src/db/syncQueue.ts`); settings go through
  `enqueueSettingsUpdate`.

### 4.2 Reads serve stale data and refresh quietly

- Lists and notes render from SQLite at once; the network refresh never gates
  showing content.
- A refresh retries a bounded number of times with backoff, and stops at once
  while the server does not answer (§3.1).
- **The SSE stream has no backfill.** Events sent while it was down are never
  delivered, so every *re*connect of the stream (not the first connect) runs a
  catch-up refresh of notes, labels and users. A bare foreground does not flip
  `isConnected`, so a refresh keyed only on that would miss them. The server
  relies on this too: it disconnects a subscriber that falls behind.
- A refresh never rolls back this device's own writes (§8.3).
- A failed refresh is staleness, not an error dialog.

### 4.3 One-shot actions are bounded, honest, and optimistic where safe

These have no queue, so they may use the network while the user waits, but
only with a **finite timeout, a visible pending state and a clear error**.

- **Optimistic where the local outcome is authoritative.** Logout clears the
  session and lands on the login screen at once, and sends `POST /logout` in the
  background. It also wipes local data, after a warning when changes are
  unsynced (§8.6); that check is local.
- **Public links are offered only while the server answers.** A queued revoke
  would leave a shared URL working for an unknown time, and there is no useful
  local state for a link the server owns.

### 4.4 Uploads

- **Finite timeout, never `0`, and a cancel button** while one runs: a stalled
  upload must end as a recoverable error, not an endless spinner.
- **A note image goes online first while the server answers** and the note
  exists on the server, so its tile can show progress. Otherwise, or after a
  transient failure, it is queued like any write and is sent after its note's
  create.
- **A permanently rejected upload is not a failed change**: it shows as an
  error tile with Retry and Dismiss, or is dropped if its note is gone.

---

## 5. Timeouts

- **Finite and tiered. Never `timeout: 0`.**
- **Queued writes get a generous budget** (`QUEUED_WRITE_TIMEOUT_MS`): there is
  no fallback to hurry toward, and a write that times out while the server
  answers is charged as a failure (§7).
- **Uploads get a longer one** (`NOTE_IMAGE_UPLOAD_TIMEOUT_MS`).
- **Reads and one-shot actions use the default** (`DEFAULT_REQUEST_TIMEOUT_MS`).
- A timeout is the worst case. While the server is known not to answer, the
  drain and reads return at once.

---

## 6. Feedback

The user can always answer three questions without doing anything:

1. **Am I connected?** One unobtrusive indicator, not a modal.
2. **Is my work safe?** Saved locally the instant they act, distinct from
   synced.
3. **Did something fail to sync?** A passive surface: the failed-note badge and
   the review screen, not a blocking dialog.

- An action with a local outcome shows **no spinner**. One that must use the
  network shows a **bounded** one and a terminal error.
- Blocking dialogs are for decisions only the user can make.
- **At most two top banners**: one status and the failed changes. When statuses
  overlap, show the most relevant one: offline, then session rejected, then
  server unreachable, then sync keeps failing. "N changes couldn't be saved —
  Review" shows whatever the connection state, until dismissed.

---

## 7. Recovery and loop safety

- **Backoff on every retry**, starting at 1 s or more and capped at 60 s. Never
  a tight loop.
- **A sync that starts while one runs is skipped**, not queued.
- **Repeated connectivity failures are capped**, then surfaced as an error.

**The queue:**

- **Order holds only where it matters.** An op is sent after every earlier op
  that touches the same note, label or settings, and is not held back by
  anything else. A write that keeps failing holds back only what depends on it
  (#1283). Currently: each queued op records its keys (`sync_queue_keys`).
- **A failure that every op would hit stops the pass and charges nothing**: no
  response at all, 401, 408, 429. A gateway status (502–504) or a client
  timeout counts as this only when the server also fails a probe; otherwise it
  belongs to the op.
- **A failing op waits its own backoff**, and its dependents wait with it. A
  reconnect or foreground lets every waiting op go at once.
- **A broken server costs a bounded number of requests per pass**, not one per
  note (#1301).
- **A short outage never turns a good edit into a failed change.** A write the
  server keeps failing reaches the review after about a day of failing, and
  never sooner (#1301). The local→server upgrade gives up after a few attempts
  instead, since the user is waiting on it. While any write has been failing
  for more than a few minutes, the sync-error banner shows.
- **A permanent rejection** (a non-transient 4xx) is resolved at once (§8.4). So
  is an error that happens on the device rather than on the server, once it has
  recurred a few times: a retry will not help, and the queue needs a way past
  it.
- **A dead-lettered create takes its note's later ops with it**, rather than each
  one failing with 404.

---

## 8. Idempotency and consistency

- **Everything created offline gets its final ID up front**, so a replayed create
  is recognised as already applied (409) and never makes a second copy. Image
  uploads carry an ID too.
- **Writes are partial**, so a replay does not overwrite fields another device
  changed.
- **Content edits are version-guarded** (`base_version`). A 409 is a real
  conflict and becomes a failed change; no answer means the edit stays queued.

The rest of this section is about what the local copy of a note may believe.

### 8.1 What the local note means

A local note row is the last server state this device applied, plus the local
edits the server has not confirmed yet.

- **The row's `version` never includes a change the row does not have.**
  Otherwise the next edit passes the server's check and overwrites a change the
  user never saw.
- **It is not older than this device's own landed edits either**, or the next
  edit conflicts with the device's own earlier write. So when the drain can
  prove a response's version holds nothing but this device's write (the server
  accepted it at `base_version` and returned `base_version` or one more), the
  row may take that version while it keeps its newer local edits.
- **`base_version` means "the version of the text the user was looking at".**
  That is the only reading under which a 409 is a real conflict.

### 8.2 Writes to one note stay in order

- **An edit and its queue row commit together**, and the row stays until the
  drain has applied the response and deleted the row in one transaction. So the
  note is protected from its edit until its outcome is stored, across a restart
  too.
- **The drain is the only sender**, with at most one request per note in flight.
- **A device never conflicts with itself.** A queued content edit stores the
  base its editor showed. When an earlier edit of the same text lands, the
  edits queued behind it move onto the new version; an edit based on any other
  version is sent as it is, so a real conflict still gets its 409. Currently:
  `rebaseQueuedEdits` and `src/db/ownVersions.ts`.

### 8.3 Applying server state

Server state arrives as a **snapshot** (a fetch or an SSE event) or as the
**response** to this device's own write.

**Snapshots:**

- **A protected note takes no snapshot.** Protected means it has a queued op or
  an unresolved failed change. The exception is a field only the server owns
  (the public link), unless this device wrote the note after the snapshot was
  taken.
- **Check and write in one transaction**, or a write slips in between.
- **A snapshot older than one of this device's writes is not applied** to that
  note. Currently: writers take a `snapshotMark()` before fetching
  (`src/db/snapshotGate.ts`).
- **Do not compare `updated_at`**, which mixes device and server clocks, and do
  not refuse a lower `version`, which would freeze every note after an operator
  restores a server backup.

**Responses to our own writes:**

- **Apply in full** only when nothing else is queued for the note and it has no
  unresolved failed change.
- **Otherwise take no content.** Take the version only as §8.1 allows. The same
  holds for the item list a check-off or bulk delete returns.
- **Check, write and delete the queue row in one transaction.**

**Convergence:** after a drain that sent anything, pull the notes it touched.
This device gets no SSE echo of its own writes. A note the server reports gone
is tombstoned under the snapshot rules.

**Labels** follow the same rule per label: a label with a queued create, rename
or delete is neither updated nor pruned by a label sync.

### 8.4 Failed changes

A failed change keeps the user's edit in the local row, so "Keep my version"
can recover it.

- **The note stays protected while a dead letter refers to it.** Only resolving
  the dead letter lifts that; a later successful op does not.
- **Nothing replaces the preserved content**: not a snapshot, not the response
  to a later write (per-user fields from it may apply), not a replay.

**Which permanent rejections become failed changes.** A rejection is only worth a
"Keep my version" prompt when the local value is the user's work:

| A permanent rejection of | Becomes |
|---|---|
| Content: create, duplicate, conversion, a title or content edit, an item create, an item text edit | A failed change: the note is badged and protected. |
| Labels: create, rename, delete | A failed change; resolving it re-reads the server's labels. |
| Settings | A failed change; the session is re-read once the queue is empty. |
| Per-user state (pin, colour, archive, collapse), trash, restore, delete, reorder | Dropped, and the notes it names are pulled: undone silently. |
| Item structure and check-offs, label membership, share and unshare | Dropped and pulled. |
| Best effort: mark viewed, image removal | Dropped; the next sync reconciles them. |

Some statuses mean the op was already applied, and are successes, not
rejections: a 404 or 410 for something being removed, a 409 replay of a create,
duplicate, item create or share, and a label create whose name already exists
(the queued ops are pointed at that label). Every other 409 is real: a version
conflict, or a username already taken.

### 8.5 Merging queued ops

A long offline session should replay as a few requests, and one conflict should
give one failed change. So an op that supersedes a queued one is merged into its
row at enqueue.

- **Merge** consecutive content saves of a note, repeated per-user changes,
  repeated reorders, and repeated edits or check-offs of one item. An edit of a
  field a queued create takes is folded into the create.
- **Never change the order** relative to other ops on the same note, label or
  settings: merge only into the last queued op sharing a key with the new one.
- **Never merge into the row being sent.**
- **Never lose a move:** a later reorder replaces an earlier one only if it names
  everything the earlier one did, since the server positions only the ids it is
  sent.
- **Never fold into a create that may already be on the server** (one the drain
  has sent), or one something queued later depends on.
- **Never put content and per-user fields in one row**: a content conflict would
  take the pin down with it.
- **Do not merge opposite pairs** (add and remove a label, share and unshare).

### 8.6 Local data belongs to one account

- **A signed-in user never sees another account's cached notes**, and the drain
  never sends another account's queued ops.
- **A deliberate logout wipes local data**, after a warning that can be cancelled
  when changes are unsynced or failed.
- **A 401 keeps it**, so the same user can sign back in and the queue drains. A
  different user signing in gets a wipe first.
- Currently: the database records its owner, checked at every sign-in before
  anything reads it (`src/db/accountOwner.ts`). A database from before the
  record is stamped with the next user rather than wiped.

### 8.7 Version history

When the server keeps revisions (#1129), an offline edit's revision is dated
when it synced, and a replayed session becomes one revision. The client does not
send its edit times, so merging (§8.5) loses nothing history would keep.

---

## 9. Where it lives

| Concern | Module (`mobile/src/`) |
|---|---|
| Connectivity, drain scheduling, reconnect | `store/OfflineContext.tsx`, `store/networkChange.ts` |
| Reachability flag, Jot response check | `api/serverReachability.ts`, `api/jotResponse.ts`, `api/client.ts` |
| Outbox, drain, rejection policy, applying responses | `db/syncQueue.ts` |
| Queue keys, merging, own-version steps | `db/queueKeys.ts`, `db/queueMerge.ts`, `db/ownVersions.ts` |
| Local note rows, snapshot gate | `db/noteQueries.ts`, `db/snapshotGate.ts` |
| Failed-change review | `hooks/useSyncFailures.ts` |
| Account ownership | `db/accountOwner.ts`, `store/AccountDataGate.tsx` |
| Reads, SSE, catch-up resync | `hooks/useOfflineNotes.ts`, `api/events.ts`, `hooks/useSSE.ts`, `store/resyncEvents.ts` |

## Known gaps

- **A late SSE event can roll a note back** (#1273). An event built before this
  device's write landed, but received after it, replaces the newer row until
  the next pull.
- **Syncing starts about 10 s after Wi-Fi reconnects** when the first request
  hits a network that is not ready yet (#1309).
