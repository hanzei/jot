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
in sync with `en.json`.

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
