---
description: Audit the codebase for technical debt and report it, ranked. Read-only.
argument-hint: "[path or area — omit for the whole repo]"
---

Audit `$ARGUMENTS` (empty means the whole repo) for technical debt. **Report only — change
nothing.** The output is a list someone triages, not a branch.

Do not sweep for `TODO`/`FIXME`: there is one such marker in the entire tree. The debt here
is structural, and it collects in the places below.

## Cross-workspace drift

The highest-value findings, and the ones invisible from inside a single workspace. Check
these even when the argument scopes you to one directory.

- Domain types or logic redefined in `webapp/src` or `mobile/src` instead of imported from
  `@jot/shared` — `shared/src/types.ts` is the single source of truth.
- The same rule implemented twice, once per client (validation, sorting, filtering, merge
  and conflict handling), especially where the two copies have already diverged.
- Strictness flags that `shared/`, `webapp/`, and `mobile/` do not all share. Per root
  `CLAUDE.md`, a flag in one `tsconfig.json` and not another is drift, not a decision.
- `migrations/sqlite/` and `migrations/postgres/` enforcing different invariants.
  `task check-migrations` compares filenames only — equivalent *behaviour* is on you.
- Hardcoded user-facing strings that never reached i18n.

## Suppressions

The markers this repo actually uses: `//nolint`, `eslint-disable`, `t.Skip` / `it.skip` /
`test.skip`, and `!` non-null assertions outside test code (root `CLAUDE.md` allows those
freely in tests, and requires a visible reason everywhere else). Report the ones carrying
no stated reason, and any skipped test that has quietly stopped running.

## Size and coupling

Files that have outgrown one responsibility — `mobile/src/screens/NoteEditorScreen.tsx`
(3077 lines), `webapp/src/components/NoteModal.tsx` (2449), and
`server/internal/handlers/notes.go` (1055) lead today. Name what should split out, not just
the line count. Also: handler logic that belongs in a `*Store`, and SQL outside
`internal/models`.

## Coverage

Handlers, stores, and hooks with no test at all; behaviour covered only by e2e that a unit
test could pin down faster. `task coverage` gives the server picture.

## Output

Rank by cost-to-carry, not by count. Per finding: `file:line`, what the debt is, what it
costs now, and the smallest fix that removes it. Note anything deliberate — much of what
looks odd here is documented in `CLAUDE.md`, and re-reporting a documented decision as debt
is noise. Close with the three worth doing next.
