# Jot Development Agent Instructions

All agent instructions live in **[`CLAUDE.md`](./CLAUDE.md)** — read that file.
It is the single source of truth for build/test commands, architecture,
conventions, and the pre-PR checklist, regardless of which agent or tool you
are running.

Additional per-area instructions apply when you work in these directories, and
are worth reading before you touch them:

- [`server/CLAUDE.md`](./server/CLAUDE.md) — Go naming and error-handling conventions
- [`webapp/CLAUDE.md`](./webapp/CLAUDE.md) — i18n rules for the web app
- [`mobile/CLAUDE.md`](./mobile/CLAUDE.md) — offline/connectivity invariants, filesystem and logging rules

This file exists only so agents that look for `AGENTS.md` find their way to
`CLAUDE.md`. Do not add instructions here — they will drift out of sync with
`CLAUDE.md` and it will not be obvious which copy is current.
