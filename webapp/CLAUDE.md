# Webapp Project Instructions

## Accessibility

Two e2e specs enforce this, and both **block** — a new violation fails
`task test-e2e`:

- `e2e/tests/accessibility.spec.ts` — axe-core scans (WCAG 2.0/2.1 A and AA) of
  the main surfaces, each in the light *and* dark theme.
- `e2e/tests/keyboard-focus.spec.ts` — the half axe cannot see: focus trapping
  and restore for every modal, keyboard drag-and-drop, toast live regions.

When you add UI:

- **A new page or view gets a scan** in `accessibility.spec.ts` — a few lines,
  since the fixtures and page objects already exist.
- **A new modal gets a focus test**, and a **new drag interaction gets a
  keyboard test**, in `keyboard-focus.spec.ts`. `@headlessui/react` and
  `@dnd-kit` do the work, but only if they are wired up right, and only these
  tests would notice if they stopped.
- **Every interactive element needs an accessible name** and every decorative
  one needs `aria-hidden="true"` (plus `tabIndex={-1}` if it would otherwise be
  focusable).
- **Check contrast in both themes.** A `dark:` variant that passes in light and
  fails in dark is the most common regression here.

Fix a failing scan rather than suppressing it. Suppression
(`AcceptedViolation` in `e2e/fixtures/axe.ts`) is for violations whose fix is a
redesign, and needs a reason and a tracking issue. There is exactly one today,
`nested-interactive` on the note-card sortable wrappers
([#799](https://github.com/hanzei/jot/issues/799)).

What these checks are *not*: axe catches roughly a third of WCAG issues, nothing
here runs a real screen reader, and a green suite is a regression guard rather
than a conformance claim. Both specs are also desktop-only — they are excluded
from the `mobile-chrome` project, since the markup does not change with the
viewport and the keyboard tests assume a physical keyboard.

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
