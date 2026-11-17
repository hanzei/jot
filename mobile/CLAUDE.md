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
truth, and the network is a background reconciler. The rules below are
outcomes; `docs/specs/mobile-connectivity-handling.md` gives the reason for
each. Meet them any way that works. If one seems to need another special case,
or code meets a rule's purpose but not its wording, raise it as a design
question instead of patching around it or rewriting working code to the
wording.

- **Device online ≠ server usable.** Offline is NetInfo `isConnected` only,
  never `isInternetReachable` (a LAN server answers without internet). Whether
  the server answers is `isServerReachable()`.
- **Only a response that echoes our `X-Request-Id` is the server's**: a captive
  portal answers plain HTTP with a `200`. The `api` instance checks it; a
  request that bypasses it (SSE, a standalone probe) uses
  `src/api/jotResponse.ts`.
- **Writes never touch the network.** A write hook calls `enqueueWrite`: the
  local edit and its queue row commit in one transaction, and the hook returns.
  Only the drain sends. A permanent rejection arrives later as a failed change
  or a silent undo (spec §8.4), so check locally what you can before queueing.
  Settings live in the session, not SQLite: queue them with
  `enqueueSettingsUpdate`.
- **Reads serve SQLite at once** and refresh in the background with bounded,
  backed-off retries that stop while the server does not answer.
- **One-shot actions** (login, PATs, public links, export) may use the network
  while the user waits, with a finite timeout, a visible pending state and a
  clear error. Logout is local-first: it clears at once and POSTs in the
  background.
- **Never `timeout: 0`.** Every request has a finite timeout.
- **Feedback is ambient** (banners, failed-note badge). A write never shows a
  pending state.
- **Recovery:** nothing that stops while the reachability flag is `false` may
  be what turns it back on (spec §3.1). The SSE stream has no backfill, so
  every reconnect of it publishes the catch-up resync
  (`src/store/resyncEvents.ts`).

## Local Data Consistency

What the device may believe after a sync (spec §8).

- **A row's `version` never includes a change the row does not have**, and a
  device never gets a conflict against its own landed edit.
- **An edit and its queue row commit in one transaction**, and the drain applies
  a response and deletes its row in one transaction.
- **A protected note** (a queued op, or an unresolved failed change) takes no
  server content, from a snapshot or from another write's response. Check and
  write in one transaction.
- **Never apply a snapshot older than this device's own write to the note**:
  take a `snapshotMark()` before fetching and pass it to the `saveServerNote*`
  writer. Never compare `updated_at`, which mixes device and server clocks.
- **Local data belongs to one account.** A deliberate logout wipes it, after a
  warning when changes are unsynced; a 401 keeps it.

## Sync Loop Safety

- Exponential backoff on every retry (start ≥ 1 s, cap 60 s); never a tight loop.
- Skip a sync that starts while one is in progress rather than queueing it.
- Cap consecutive connectivity failures, then surface an error.
- A failing write holds back only the writes that touch the same note, label or
  settings, and a short server outage never turns a good edit into a failed
  change (spec §7).
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
