# Mobile Project Instructions

## i18n / Translations

When adding new i18n keys to `src/i18n/locales/en.json`, you **must** also add
the corresponding key with an appropriate translated value to every other locale
file in the same directory:

- `de.json` — German
- `es.json` — Spanish
- `fr.json` — French
- `it.json` — Italian
- `nl.json` — Dutch
- `pl.json` — Polish
- `pt.json` — Portuguese

Do not use the English string as a placeholder in non-English locales. Provide a
proper translation for each language.

Run `task check-translations` after adding keys to verify all locale files are
in sync with `en.json`. This task runs from the `webapp/` directory but its
script checks both webapp and mobile locale directories.

## Connectivity & Offline Handling

The app is **local-first**: the local SQLite DB + sync queue is the source of truth
for the UI, and the network is a background reconciler. A user action must never block
on the network for something the app can do locally. Full rationale, the decision
matrix, and the code map live in `docs/specs/mobile-connectivity-handling.md`; the
load-bearing rules:

- **Three distinct connectivity states — don't conflate them.** Device offline (NetInfo
  `isConnected`), server-unreachable-while-online (`isServerReachable()` in
  `src/api/serverReachability.ts`), and slow/flaky. "Device online" ≠ "server usable".
- **Writes never block.** Commit optimistically to local state + DB, enqueue for replay,
  return immediately. Gate the network attempt on `isOnlineWriteAllowed()` so a
  known-unreachable server skips straight to the queue instead of eating the timeout.
  Roll back only on a *permanent* (non-queueable) rejection.
- **Reads serve stale, refresh in the background.** Render the local cache immediately;
  never block initial load or refresh on the network. Background refresh uses bounded
  retries with backoff (`retrySync`) and should consult `isServerReachable()` so it
  stops hammering a known-down server.
- **Auth & one-shot ops** (login, logout, PAT) have no queue, so they may touch the
  network on the critical path — but only with a **finite** timeout and a visible
  pending state, never a silent freeze. Be optimistic where the local outcome is
  authoritative (e.g. logout clears the session locally and POSTs in the background).
  Note-image uploads are *not* in this class — they fall back to the offline upload
  queue like any other write.
- **Timeouts are finite and tiered; never `timeout: 0`.** Writes get the short budget
  (`WRITE_REQUEST_TIMEOUT_MS`) because a local fallback is waiting; reads/auth get the
  longer default (`DEFAULT_REQUEST_TIMEOUT_MS`). The timeout is the worst case — the
  reachability flag should make a known-down server fall back immediately.
- **Feedback is ambient, not per-action.** An action with a local fallback is instant (no
  spinner). Surface connectivity and "saved locally / syncing / sync failed" as ambient
  state (banners, the failed-note badge), not blocking dialogs. Distinguish *transient*
  (queued, will retry) from *permanent* (a real error to show the user).
- **Recovery + loop safety.** Re-arm reachability on any successful response / SSE reopen
  / device reconnect, then drain. On SSE **reopen** also publish a one-shot catch-up
  resync (`src/store/resyncEvents.ts`) so the read caches (notes, labels, users) re-pull
  events missed while the stream was down (e.g. while backgrounded) — a bare foreground
  doesn't flip `isConnected`, so the `isConnected`-keyed refresh alone misses it. Retries
  follow the **Sync Loop Safety** rules below.

## Sync Loop Safety

The mobile app uses SSE, React Query, and an offline SQLite sync layer — all surfaces where sync loops can form. Follow these rules:

- Always apply exponential backoff on retry (start ≥ 1 s, cap at 60 s); never retry in a tight loop.
- Detect and break re-entrant sync: if a sync is already in progress, skip rather than queue a second one.
- Cap the number of consecutive sync attempts before surfacing an error to the user.
- Prefer idempotent writes (upsert, not insert-then-update) so a replayed sync event is harmless.

## Filesystem Access

All filesystem work goes through **`src/utils/fs.ts`** — it is the only module
allowed to import `expo-file-system`. Do not add `expo-file-system` imports
elsewhere, and never import `expo-file-system/legacy` (the pre-SDK-54 API; the
codebase no longer uses it).

The wrapper exists because the modern `File`/`Directory` API differs from the
legacy one in ways that are easy to get wrong per call site:

- Most operations are **synchronous** (`write`, `delete`, `create`, `exists`,
  `size`) — only `copy`/`move`/download are promise-based.
- `File.delete()` **throws** when the target is missing. Use
  `deleteFileIfExists()` for the old idempotent-delete behaviour.
- `File.downloadFileAsync()` **rejects** on a non-2xx response instead of
  resolving with a status code, and refuses an existing destination unless
  `idempotent` is set. `downloadFile()` handles both; callers branch with
  `try`/`catch`, not on a status field.

Paths are passed as `file:///` URI strings, not `File` instances, because some
are persisted (`pending_image_uploads.local_path`) and must stay comparable
across app versions. Build them with `documentPath()` (durable) or
`cachePath()` (OS may purge).

## Diagnostics Logging

`src/utils/logger.ts` patches `console.info/warn/error` (installed by
`initLogger()` at the top of `App.tsx`, before React mounts) and keeps entries
in two places:

- A JSONL file under the document directory — `getPersistedLogs()`. This is the
  log history, and it survives the restart that follows a crash.
- An in-memory ring buffer of the last **200** entries — `getLogs()`. This is
  *not* the history: it exists so the Diagnostics preview (which re-reads on
  every connectivity flip) doesn't parse the file each time, and so logs still
  exist when persistence is unavailable. Prefer `getPersistedLogs()` anywhere
  the full record matters.

**Retention is size-based only.** The active file rotates once it passes 512 KiB
and exactly one rotated generation is kept, capping logs at ~1 MiB. There is
deliberately no age-based expiry: a quiet install keeps its history until new
entries push it out.

Writes are batched (flushed every 2 s, on a 200-entry burst, and when the app
backgrounds) rather than hitting disk per call. The logger must **never**
`console.*` on its own failure path — that recurses through the patched
console; repeated flush failures instead disable persistence and leave the
in-memory buffer working.

Anything logged now lands on disk and rides along in shared diagnostics
reports, so don't log note content, credentials, or tokens.

## Database Tests

`src/db/` runs its SQL against a **real SQLite engine** in Jest, not a stub.
`__tests__/helpers/testDb.ts` implements the `expo-sqlite` surface the app uses
(`execAsync`, `runAsync`, `getAllAsync`, `getFirstAsync`, `withTransactionAsync`,
`closeAsync`) on top of Node's built-in `node:sqlite`, and `jest.setup.js` mocks
`expo-sqlite` with it. Same intent as the filesystem mock above: run the app's
own logic rather than assert against canned return values.

- A **fresh in-memory database, fully migrated**, is installed before every test
  by `jest.setupAfterEnv.js`. Reach it as `globalThis.testDb`; it is also what
  the mocked `useSQLiteContext()` and `SQLiteProvider` hand out. Nothing leaks
  between tests, and no suite has to opt in.
- Migration tests start from `createTestDb()` instead — an empty, unmigrated
  database.
- Every method is a `jest.fn()` wrapping real execution, so `toHaveBeenCalled`
  still works. Prefer asserting on **query results**: pinning SQL text was what
  let a query reference a column that does not exist and still pass.
- Constraints, defaults, `ON DELETE CASCADE`, and transaction rollback are all
  live. A test that seeds a `note_items` or `pending_image_uploads` row must
  insert its parent note first, and a `withSerializedTransaction` body that
  throws really does roll back.
- The adapter mirrors expo-sqlite's own quirks deliberately — booleans bind as
  1/0, `undefined` binds as NULL, `getFirstAsync` resolves `null` (not
  `undefined`) for a missing row. Keep it that way; the point is that passing
  here means passing on device.
- Row builders (`makeTextNote`, `makeListNote`, `seedQueueEntry`, …) live in
  `__tests__/helpers/fixtures.ts`.
- `tsconfig.json` carries `"node"` in `types` so the helper can import
  `node:sqlite`. Nothing under `src/` may rely on a Node-only global as a
  result — the app runs on Hermes, not Node.

## Safe Area Insets

Screens use `headerShown: false`, so any screen or component rendering content
against a screen edge (headers, banners, FABs, toolbars, bottom sheets) must
apply safe-area insets itself: `paddingTop: insets.top` for top content,
`paddingBottom: insets.bottom` for bottom content. Read insets with
`useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 }`
so components don't throw when rendered without a provider (e.g. in unit tests).
