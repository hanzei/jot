# Webapp Project Instructions

## Accessibility

`e2e/tests/accessibility.spec.ts` (axe, light and dark theme) and
`e2e/tests/keyboard-focus.spec.ts` (focus trapping/restore, keyboard
drag-and-drop, live regions) both block `task test-e2e`. When you add UI:

- A new page or view gets a scan in `accessibility.spec.ts`.
- A new modal gets a focus test, and a new drag interaction a keyboard test, in
  `keyboard-focus.spec.ts` — `@headlessui/react` and `@dnd-kit` only work if
  wired correctly, and only these tests notice when they are not.
- Every interactive element needs an accessible name; decorative ones get
  `aria-hidden="true"` (and `tabIndex={-1}` if otherwise focusable).
- Check contrast in **both** themes — a `dark:` variant failing in dark mode is
  the most common regression.
- Fix a failing scan rather than suppressing it. `AcceptedViolation`
  (`e2e/fixtures/axe.ts`) is only for fixes that need a redesign, with a reason
  and a tracking issue; there are none today.
- For a card that is both a control and a container, copy `NoteCard`: a plain
  `div` with a stretched `[data-note-card]` button as the focus target
  (`DashboardPage.noteCardButton()` in e2e), and drag `listeners` without
  `attributes` on the card.

## i18n / Translations

Every key added to `src/i18n/locales/en.json` needs a real translation in every
other locale file — never the English string as a placeholder. Verify with
`task check-translations`.
