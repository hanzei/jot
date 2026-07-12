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
- **Auth & one-shot ops** (login, logout, PAT, uploads) have no queue, so they may touch
  the network on the critical path — but only with a **finite** timeout and a visible
  pending state, never a silent freeze. Be optimistic where the local outcome is
  authoritative (e.g. logout clears the session locally and POSTs in the background).
- **Timeouts are finite and tiered; never `timeout: 0`.** Writes get the short budget
  (`WRITE_REQUEST_TIMEOUT_MS`) because a local fallback is waiting; reads/auth get the
  longer default (`DEFAULT_REQUEST_TIMEOUT_MS`). The timeout is the worst case — the
  reachability flag should make a known-down server fall back immediately.
- **Feedback is ambient, not per-action.** An action with a local fallback is instant (no
  spinner). Surface connectivity and "saved locally / syncing / sync failed" as ambient
  state (banners, the failed-note badge), not blocking dialogs. Distinguish *transient*
  (queued, will retry) from *permanent* (a real error to show the user).
- **Recovery + loop safety.** Re-arm reachability on any successful response / SSE reopen
  / device reconnect, then drain. Retries follow the **Sync Loop Safety** rules below.

## Sync Loop Safety

The mobile app uses SSE, React Query, and an offline SQLite sync layer — all surfaces where sync loops can form. Follow these rules:

- Always apply exponential backoff on retry (start ≥ 1 s, cap at 60 s); never retry in a tight loop.
- Detect and break re-entrant sync: if a sync is already in progress, skip rather than queue a second one.
- Cap the number of consecutive sync attempts before surfacing an error to the user.
- Prefer idempotent writes (upsert, not insert-then-update) so a replayed sync event is harmless.

## Safe Area Insets

Screens use `headerShown: false`, so any screen or component rendering content
against a screen edge (headers, banners, FABs, toolbars, bottom sheets) must
apply safe-area insets itself: `paddingTop: insets.top` for top content,
`paddingBottom: insets.bottom` for bottom content. Read insets with
`useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 }`
so components don't throw when rendered without a provider (e.g. in unit tests).
