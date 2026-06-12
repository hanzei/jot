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

## Safe Area Insets

All screens are registered with `headerShown: false`, so there is no navigation
header to absorb the status bar / notch / home-indicator. Each screen — and any
component that renders content flush against a screen edge (custom headers, top
banners, FABs, bottom toolbars, bottom sheets/modals) — is responsible for
applying safe-area insets itself. Without this, content renders under the status
bar at the top or the gesture bar at the bottom.

- Apply `insets.top` to top-edge content (via `paddingTop`) and `insets.bottom`
  to bottom-edge content (via `paddingBottom`). Centered/scrollable forms should
  pad both edges so content stays in the safe area even when it grows.
- Read insets with `useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 }`
  for components that may render without a `SafeAreaProvider` (e.g. in unit
  tests that render the component in isolation). `useSafeAreaInsets()` is fine
  for screens whose tests mock `react-native-safe-area-context`.
