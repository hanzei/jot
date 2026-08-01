# Accessibility checks (webapp)

How Jot's webapp accessibility is verified, what the first automated baseline
found, and the one violation that is deliberately still there.

Scope is the webapp. The mobile app carries ~236 `accessibilityLabel` /
`accessibilityRole` props and no automated verification; auditing it needs a
manual TalkBack/VoiceOver pass on a device and is tracked separately in
[#792](https://github.com/hanzei/jot/issues/792).

## What runs

Two Playwright specs, both desktop-only (`chromium` project):

| Spec | Covers |
| --- | --- |
| `webapp/e2e/tests/accessibility.spec.ts` | axe-core scans of seven surfaces × two themes |
| `webapp/e2e/tests/keyboard-focus.spec.ts` | focus trapping, focus restore, keyboard drag-and-drop, toast live regions |

They are complements. axe checks the static accessibility tree and catches
roughly a third of WCAG issues; it says nothing about whether Escape closes a
dialog, whether focus comes back afterwards, or whether a pointer-only
affordance has a keyboard path. Neither spec alone is a meaningful check.

Both run as part of `task test-e2e`. They are **blocking** — a new violation
fails the e2e job. There is no report-only mode, because nothing would force a
report-only baseline to ever get clean.

### axe scans

`webapp/e2e/fixtures/axe.ts` wraps `@axe-core/playwright`. Surfaces scanned:
Login, Register, Dashboard (populated, not the empty state), the note modal,
Settings, My Tasks, and Admin.

Three choices in there are worth knowing about:

- **WCAG 2.0/2.1 A and AA only** (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`).
  axe's `best-practice` tag is excluded on purpose: those rules are advice
  rather than standards, and mixing them in makes a failing scan ambiguous
  about whether anything is actually broken. A narrower set that is enforced
  beats a wider set that gets ignored.
- **Both themes, every surface.** `test.use({ colorScheme })` drives the
  system preference, which the default `theme: 'system'` setting follows.
  Contrast is the only rule whose result depends on rendered colour, so a
  light-only scan says nothing about the `dark:` variants — and Jot styles
  nearly every surface in both. Each test asserts the `dark` class actually
  landed on `<html>`, so a broken theme fails loudly instead of silently
  running both scans in light mode.
- **Animations are waited out** before scanning. `animate-pop-in` and
  `animate-fade-in` mean axe can sample a blend of the text and background
  colours mid-transition and report contrast failures that do not exist once
  the element settles — a different one on each run.

### Keyboard and focus

`@headlessui/react` `Dialog` backs every modal (`NoteModal`, `ShareModal`,
`ConfirmDialog`, `KeyboardShortcutsDialog`, `ImageLightbox`) and provides the
focus trap and restore; `@dnd-kit`'s `KeyboardSensor` is wired into both drag
contexts. The tests assert that behaviour rather than assume it, because it
comes from dependencies: a bump or a stray `role` can remove it silently and
nothing else in the suite would notice. The `ConfirmDialog` Escape bug below is
exactly that failure mode, found by exactly that test.

## The baseline

First run, before any fixes: **8 of 14 axe scans failing**, 5 distinct rules.
Login, Register and Settings were clean in both themes from the start.

| Rule | Impact | Where | Outcome |
| --- | --- | --- | --- |
| `label` | critical | Note-card list preview checkboxes; note modal list item checkboxes and textareas | Fixed |
| `aria-allowed-attr` | critical | `aria-expanded` on a bare `textarea` in list rows | Fixed |
| `color-contrast` | serious | Note modal "Last edited"; Admin "You" badge and Delete button | Fixed |
| `color-contrast` | serious | My Tasks empty state | Not a real failure — scan was sampling mid-animation |
| `nested-interactive` | serious | Sortable note-card wrappers | **Accepted**, see below |
| `nested-interactive` | serious | Sortable list rows in the note modal | Fixed |

### Fixes

- **`SortableItem` grip is now a real `<button>`** carrying both `attributes`
  and `listeners`. They were split — `attributes` (role, `tabIndex`, drag
  instructions) on the row, `listeners` on a non-focusable `div` — which left a
  focusable element that did nothing and a grip no keyboard user could reach.
  Keyboard reordering of list items did not work at all before this; it does
  now, and `keyboard-focus.spec.ts` holds it there.
- **List item checkbox and textarea got accessible names**, and the textarea
  got `role="combobox"`. It autocompletes from completed items, so it already
  carried `aria-expanded`/`-controls`/`-activedescendant` — none of which are
  legal on a plain textbox.
- **Note-card preview checkboxes are `aria-hidden` and untabbable.** That
  preview only ever renders uncompleted items, so the box conveys nothing, and
  in the tree it was an unlabelled control plus a spurious tab stop inside a
  card that is itself one tab stop.
- **Three contrast pairs re-toned.** "Last edited" 2.60 → 4.84 (light) and
  3.02 → 5.62 (dark); the Admin "You" badge 4.39 → 6.87 and 3.98 → 7.03; the
  Admin Delete button 3.58 → 5.40 in dark.
- **`ConfirmDialog` closes on Escape again.** Its `onKeyDown` stops
  propagation so a note card's drag listeners cannot swallow Enter, and that
  also stopped the native event reaching headlessui's Escape listener — so
  backing out of a destructive prompt meant hunting for the Cancel button. The
  handler now calls `onCancel` itself.

### Accepted violation

One, `nested-interactive` on the note-card sortable wrapper, tracked in
[#799](https://github.com/hanzei/jot/issues/799).

The whole card is the drag surface, so `@dnd-kit` gives its wrapper
`role="button"`, and the card contains the overflow-menu button. Clearing it
means either a dedicated drag handle or demoting the card from a single
activatable target — both redesigns of the note grid, and out of scope for a
change whose job was to establish the baseline.

It is accepted node by node, not by disabling the rule: `AcceptedViolation`
matches on markup (`data-drag-disabled`), so `nested-interactive` still fails
for anything else on those pages.

## Expectations for new UI

The short version lives in [`webapp/CLAUDE.md`](../../webapp/CLAUDE.md). New
user-facing surfaces get an axe scan in `accessibility.spec.ts`; new modals and
new drag interactions get a focus or keyboard test alongside the existing ones.

When a scan starts failing, fix the markup. Accepting a violation is for the
case where the fix is a redesign, and it needs a reason and an issue — an
accepted violation with no owner is just a muted one.

## Not covered

- Mobile viewport scans. Both specs are excluded from the `mobile-chrome`
  project: the markup does not change with the viewport, so the axe scans would
  re-check the same components against the same rules, and the keyboard tests
  assume a physical keyboard that emulation does not model.
- Screen-reader output. Nothing here runs NVDA, JAWS or VoiceOver; a correct
  accessibility tree is not the same as a usable announcement.
- Any formal WCAG conformance claim. These scans are a regression guard, not an
  audit.
