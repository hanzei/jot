# Mobile Project Instructions

## Running the app on a device

Jest and `typecheck` do not tell you whether a screen renders. Run anything
user-facing on an emulator or device before calling it done.

- **Expo Go does not work** — native modules (`expo-share-intent`,
  `expo-quick-actions`) need a dev build (`npx expo run:android`, or an EAS build
  via `adb install`).
- A **blank white screen with nothing in logcat** means the Metro forward is
  gone, not a broken build: re-run `adb reverse tcp:8081 tcp:8081`. It is lost
  whenever the device or adb server restarts.
- From an Android emulator the host server is `http://10.0.2.2:8080`;
  `localhost` is the emulator itself.
- CI builds `arm64-v8a`. For an x86_64 emulator, build natively with
  `-PreactNativeArchitectures=x86_64` rather than relying on arm64 translation
  (check `adb shell getprop ro.product.cpu.abilist`).
- JS/TS changes hot-reload. Rebuild natively only for a new native module, a
  config plugin, or an Expo SDK bump.
- `npx expo prebuild` rewrites the tracked `package.json` (`android`/`ios`
  scripts become `expo run:*`) — revert that unless intended.
- `android/` is generated (CI runs `expo prebuild --clean`); hand-edits never
  ship. Native customization goes in a config plugin in `app.json`.

## Driving the UI from a terminal

Android exposes `testID`s as `resource-id`, so the UI can be driven by name:

```bash
adb shell uiautomator dump /sdcard/ui.xml
adb shell cat /sdcard/ui.xml | sed 's/></>\n</g' \
  | sed -nE 's/.*text="([^"]*)".*resource-id="([^"]*)".*bounds="([^"]*)".*/\2\t\1\t\3/p'

adb exec-out screencap -p > /tmp/screen.png
adb shell input tap <x> <y>
adb logcat -d | grep -E "ReactNativeJS|AndroidRuntime|FATAL"
```

- **Re-dump between every step** — any layout change, notably the soft
  keyboard opening, makes coordinates stale.
- Add a `testID` to every new interactive element.
- On a debug build, `adb shell run-as com.jot.app` reaches `files/SQLite/`.
  Copy `.db`, `.db-shm`, **and** `.db-wal` (with WAL the `.db` alone is usually
  empty), and `adb shell am force-stop com.jot.app` first when the snapshot must
  be consistent.

## Device Tests (Maestro)

`e2e/flows/` runs via `task test-mobile-e2e` (`e2e/run.sh` starts its own
server); `task check-mobile-flows` only syntax-checks. These tests are
deliberately narrow — real connectivity transitions, process lifecycle, OS
integration. **Anything testable in Jest belongs in Jest.**

- Flows run in numbered order and **share app state**; only `01` clears it.
- Steps shared between flows go in `e2e/flows/helpers/` (called with
  `runFlow`), which `run.sh` never runs on their own.
- The SSO flows drive the mock IdP's page inside a Chrome Custom Tab; match
  its visible text (`"Username"`, `"Approve"`), since it has no `testID`s.
- The import flow drives Android's system file picker the same way
  (`flows/helpers/pick-download.yaml`); `run.sh` pushes the files it picks into
  `/sdcard/Download`.
- Maestro cannot shell out mid-flow, so `adb` steps (airplane mode, Wi-Fi probe, force-stop,
  intents) are sequenced in `run.sh` between flows.
- No drag-and-drop flows (Maestro has no press-hold-then-move) and no quick
  action flows (`adb` cannot build that intent) — cover both in Jest.
- Assert on `testID`, except note cards, whose IDs embed the note id — match
  the title text there.
- The Maestro version is pinned in `scripts/check-maestro.sh`; do not float it.
- A driver death before a flow's first step re-runs that flow (`run.sh`); any
  other driver death re-runs the whole set (`ci-run.sh`). Both classify through
  `e2e/lib.sh`, so run `task test-mobile-e2e-scripts` after touching it.

## i18n / Translations

Every key added to `src/i18n/locales/en.json` needs a real translation in every
other locale file — never the English string as a placeholder.
`task check-translations` checks key parity (missing, extra, unused keys) and that
every plural key has exactly the forms its locale uses (Polish `_few`/`_many`, but
no `_few` in German). It cannot tell a real translation from a copied English value, so
review the values yourself.

## Connectivity & Offline Handling

The app is **local-first**: the SQLite DB plus sync queue is the UI's source of
truth, and the network is a background reconciler. Rationale and code map:
`docs/specs/mobile-connectivity-handling.md`. The rules:

- **Three connectivity states** — device offline (NetInfo `isConnected` only,
  never `isInternetReachable`, #1266), server
  unreachable while online (`isServerReachable()`), and slow/flaky. Device
  online ≠ server usable.
- **Only a response that echoes our `X-Request-Id` is the server's** (spec
  §3.2): a captive portal answers plain HTTP with a `200`. The `api` instance
  checks it for you; a request that bypasses it (SSE, a probe on its own axios
  call) must use `src/api/jotResponse.ts` itself.
- **Writes go through the outbox** (spec §4.1). A write hook calls
  `enqueueWrite`: the local edit and its queue row commit in one transaction,
  and the hook returns without touching the network. The drain is the only
  sender. A permanent rejection arrives later, never as an error from the
  action: content, label and settings changes become failed changes, the rest
  are undone silently from server state (spec §8.4,
  `SERVER_STATE_ON_REJECTION_OPERATIONS`). Validate locally what you can before
  queueing. Settings go through `enqueueSettingsUpdate`. No write hook reads
  `isOnlineWriteAllowed()`; it gates one-shot actions and note-image uploads,
  which still go online first and fall back to the sync queue (spec §4.4).
- **Reads serve the local cache immediately** and refresh in the background with
  bounded, backed-off retries (`retrySync`) that respect `isServerReachable()`.
- **Auth and one-shot ops** (login, logout, PAT) may hit the network on the
  critical path, but only with a finite timeout and a visible pending state.
  Be optimistic where the local outcome is authoritative (logout clears locally,
  POSTs in the background).
- **Timeouts are finite and tiered; never `timeout: 0`.** Queue replays use
  `QUEUED_WRITE_TIMEOUT_MS`, the only timeout a write has; uploads
  `NOTE_IMAGE_UPLOAD_TIMEOUT_MS`; reads/auth/one-shot `DEFAULT_REQUEST_TIMEOUT_MS`.
- **Feedback is ambient** (banners, failed-note badge), not spinners or dialogs
  per action; a write never shows a pending state. Distinguish transient
  (queued) from permanent failures.
- **Recovery:** nothing that stops while the reachability flag is `false` may
  be what re-arms it, and a flip back resumes a parked drain (spec §3.1). On SSE
  reopen also publish the catch-up resync
  (`src/store/resyncEvents.ts`) — a bare foreground does not flip `isConnected`,
  so the `isConnected`-keyed refresh alone misses events.

## Local Data Consistency

What the device may believe after a sync (spec §8). These are the target; spec
§8.8 lists the rules the code does not follow yet, each with its issue.

- **`version` and content move together.** Never store a server version without
  the content it belongs to, or the reverse.
- **Writes to one note stay in order.** The drain is the only sender and sends
  them FIFO per key.
- **An op that supersedes a queued one is merged into its row** at enqueue
  (spec §8.5, `src/db/queueMerge.ts`): only into the last op sharing a key,
  never into the row the drain is sending, never content and per-user fields
  together. The drain re-reads each row when it reaches it
  (`claimQueueEntry`); never send a row from the pass's initial load.
- **A write commits its local edit and its queue row in one transaction**
  (`enqueueWrite`), and the drain applies the response and deletes the row in
  one transaction.
- **A queued content edit or conversion stores the `base_version` its editor
  showed.** When the drain lands one as this device's own version, it rebases
  the edits queued at the same base in that transaction (`rebaseQueuedEdits`);
  an edit enqueued later resolves its base through `src/db/ownVersions.ts`.
- **A protected note** (queued op or an unresolved failed change) takes no
  server content, from a snapshot or from the response to another write. Check
  and write in one transaction.
- **Never apply a snapshot older than this device's own write to the note.**
  Take a `snapshotMark()` before fetching and pass it to the `saveServerNote*`
  writer (`src/db/snapshotGate.ts`); never compare `updated_at`, which mixes
  device and server clocks.
- **After a write lands,** apply the response in full only when nothing else is
  queued for the note and it has no unresolved failed change; otherwise take
  neither content nor version.
- **Local data belongs to one account.** A deliberate logout wipes it, after a
  warning when changes are unsynced; a 401 keeps it.

## Sync Loop Safety

- Exponential backoff on every retry (start ≥ 1 s, cap 60 s); never a tight loop.
- The drain is **FIFO per key**, not strict FIFO (spec §7): an op that fails
  transiently holds back only the later ops that share a key with it
  (`sync_queue_keys`), stays queued, and waits its own backoff before it is
  resent (`next_attempt_at`); one failing write never holds back unrelated ones.
- A write the server keeps failing with 5xx reaches the failed-changes review
  after a bounded time (`first_failed_at`: both a long failure run and several
  attempts, never either alone); never dead-letter one sooner, or a short
  outage turns good edits into failed changes.
- A broken server costs a bounded number of requests per pass: a pass stops
  after a few failed sends in a row.
- Skip a sync that starts while one is in progress rather than queueing it.
- Cap consecutive connectivity failures, then surface an error.
- Idempotent writes: `INSERT … ON CONFLICT(id) DO UPDATE`, **never
  `INSERT OR REPLACE`** — with `foreign_keys = ON`, REPLACE's delete fires
  `ON DELETE CASCADE` and silently wipes child rows (it once deleted queued image
  uploads), and it resets omitted columns such as `notes.sync_state`.

## Filesystem Access

Only `src/utils/fs.ts` may import `expo-file-system`; never import
`expo-file-system/legacy`. In tests, seed the in-memory
`globalThis.mockFileSystem` from `jest.setup.js` rather than stubbing calls.

## Diagnostics Logging

`src/utils/logger.ts` persists console output to disk, and those logs ship in
diagnostics reports: **never log note content, credentials, or tokens.** Use
`getPersistedLogs()` wherever the full history matters — `getLogs()` is only the
current process's last 200 entries.

## Database Tests

`src/db/` runs real SQL in Jest (`node:sqlite` behind the `expo-sqlite` mock).

- Every test gets a fresh, migrated in-memory DB as `globalThis.testDb`;
  migration tests use `createTestDb()` for an unmigrated one.
- Assert on query results, not SQL text — pinning SQL is how a query against a
  nonexistent column once passed.
- Constraints are live: seed a parent note before its `note_items` or
  `pending_image_uploads` rows.
- Keep the adapter's expo-sqlite quirks (1/0 booleans, `undefined` → NULL,
  `null` for a missing first row) — passing here must mean passing on device.
- Fixtures live in `__tests__/helpers/fixtures.ts`.
- `tsconfig.json` includes Node `types` for that helper only; nothing in `src/`
  may use a Node-only global (the app runs on Hermes).

## Console Output in Tests

`jest.setupAfterEnv.js` fails any test that writes an unexpected
`console.error` (`__tests__/helpers/consoleGuard.ts`), so a clean run prints
nothing.

- **React act() warnings are bugs in the test.** Await RNTL's async APIs
  (`await fireEvent…`, `await render`, `await unmount()`), wrap direct triggers
  in `await act(...)`, and wait on conditions with `waitFor` — never a
  real-timer sleep.
- A test that drives an error path on purpose calls
  `allowConsoleError('<expected text>')`; expected warn/info diagnostics use
  `silenceConsole('warn', /pattern/)`. Both reset after every test.
- There is no `forceExit`. A "worker process has failed to exit gracefully"
  warning means something leaked a handle; locate it with
  `npm run test:handles`.

## Safe Area Insets

Screens use `headerShown: false`, so edge-touching content applies insets itself.
Read them as `useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 }`
so components render without a provider in tests.

- **Apply `insets.top` unconditionally.** `ContentSafeArea` already zeroes it
  while a top banner is shown, so `bannerShown ? 0 : insets.top` is a bug. Do
  not consume `useBannerShown` outside `ContentSafeArea`.
- Keep the inset flip instant; animating it reintroduces the layout jump.
- Exception: a full-screen RN `Modal` renders above the banners and uses
  `useDeviceSafeAreaInsets()` (e.g. `ImageLightbox`).
