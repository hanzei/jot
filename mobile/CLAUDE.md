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
- Maestro cannot shell out mid-flow, so `adb` steps (airplane mode, force-stop,
  intents) are sequenced in `run.sh` between flows.
- No drag-and-drop flows (Maestro has no press-hold-then-move) and no quick
  action flows (`adb` cannot build that intent) — cover both in Jest.
- Assert on `testID`, except note cards, whose IDs embed the note id — match
  the title text there.
- The Maestro version is pinned in `scripts/check-maestro.sh`; do not float it.

## i18n / Translations

Every key added to `src/i18n/locales/en.json` needs a real translation in every
other locale file — never the English string as a placeholder.
`task check-translations` checks key parity (missing, extra, unused keys) only;
it cannot tell a real translation from a copied English value, so review the
values yourself.

## Connectivity & Offline Handling

The app is **local-first**: the SQLite DB plus sync queue is the UI's source of
truth, and the network is a background reconciler. Rationale and code map:
`docs/specs/mobile-connectivity-handling.md`. The rules:

- **Three connectivity states** — device offline (NetInfo `isConnected`), server
  unreachable while online (`isServerReachable()`), and slow/flaky. Device
  online ≠ server usable.
- **Writes never block.** Commit locally, enqueue, return. Gate the network
  attempt on `isOnlineWriteAllowed()`. Roll back only on a *permanent*
  rejection. Note-image uploads follow this too, via the offline upload queue.
- **Reads serve the local cache immediately** and refresh in the background with
  bounded, backed-off retries (`retrySync`) that respect `isServerReachable()`.
- **Auth and one-shot ops** (login, logout, PAT) may hit the network on the
  critical path, but only with a finite timeout and a visible pending state.
  Be optimistic where the local outcome is authoritative (logout clears locally,
  POSTs in the background).
- **Timeouts are finite and tiered; never `timeout: 0`.** Writes use
  `WRITE_REQUEST_TIMEOUT_MS`, reads/auth `DEFAULT_REQUEST_TIMEOUT_MS`.
- **Feedback is ambient** (banners, failed-note badge), not spinners or dialogs
  per action. Distinguish transient (queued) from permanent failures.
- **Recovery:** re-arm reachability on any success / SSE reopen / reconnect, then
  drain. On SSE reopen also publish the catch-up resync
  (`src/store/resyncEvents.ts`) — a bare foreground does not flip `isConnected`,
  so the `isConnected`-keyed refresh alone misses events.

## Sync Loop Safety

- Exponential backoff on every retry (start ≥ 1 s, cap 60 s); never a tight loop.
- Skip a sync that starts while one is in progress rather than queueing it.
- Cap consecutive sync attempts, then surface an error.
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
