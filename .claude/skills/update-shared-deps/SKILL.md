---
name: update-shared-deps
description: Update npm dependencies in shared/ (the @jot/shared package) — eslint, typescript, vitest and friends. Use this whenever the user asks to update, upgrade, or refresh dependencies in shared/, the @jot/shared package, or the shared types package, and as the FIRST step of any repo-wide dependency sweep, since webapp/ and mobile/ consume shared via `file:../shared` and type-check its source with their own compilers. Prefer this over a plain `npm update` in shared/ — a TypeScript or ESLint bump here silently breaks the two consumers, which is only visible if you run their checks too.
---

# Update shared (@jot/shared) dependencies

`shared/` is a tiny package — six devDependencies, no runtime dependencies — but it sits
upstream of both consumers. It ships **TypeScript source**, not a build output:
`package.json` points `main`/`types` straight at `src/index.ts`, and `webapp/` and
`mobile/` pull it in via `file:../shared`. So the compiler that actually type-checks this
code in CI is *webapp's* and *mobile's* TypeScript, not the one pinned here.

That single fact drives everything below: the update itself takes two minutes, and the
verification is what matters.

## Before you start

Work on a feature branch, never `master` (root `CLAUDE.md`).

```bash
git status --short
git checkout -b chore/update-shared-deps   # or the branch you were told to use
```

## 1. See what's available

```bash
cd shared
npm outdated             # works offline, no tool install needed
npx npm-check-updates    # shows majors that `npm outdated` presents as satisfied ranges
```

If `npx npm-check-updates` can't be fetched, `npm outdated` plus
`npm install <pkg>@<version>` covers the same ground.

## 2. Apply the updates

Patch and minor bumps can go in one batch. Take each major on its own so a failure points
at a single package:

```bash
npx npm-check-updates -u --target minor && npm install
# then, one at a time:
npx npm-check-updates -u --filter eslint,@eslint/js && npm install
```

Keep `package-lock.json` in the commit — CI installs with `npm ci` and will fail on a
lockfile that doesn't match `package.json`.

### Packages that need a moment's thought

- **typescript** — a major here means nothing on its own; the consumers compile this
  source. Bump it in `shared/`, `webapp/`, and `mobile/` together, or not at all. All
  three are currently on the same range for exactly this reason.
- **eslint / @typescript-eslint** — `shared/` runs ESLint 10 while `webapp/` and `mobile/`
  are still on 9. That drift is contained and fine: each workspace has its own lockfile,
  `node_modules`, and flat config, and lint always runs from the workspace directory, so
  the versions never meet. It's also not a preference — the consumers are *blocked*, see
  the note in `update-webapp-deps`, while `shared/` has neither react plugin and could
  move.

  Because it moved first, `shared/` is a useful canary: it already proves
  `@typescript-eslint` 8.65 works under ESLint 10. When the consumers eventually follow,
  the open question is only their react plugins.

- **@eslint/js must track the `eslint` major.** `shared/eslint.config.js` imports it
  directly, and bumping `eslint` to 10 without bumping `@eslint/js` broke CI once already
  (#749 — under ESLint 9 the import resolved through a hoisted transitive copy, which
  ESLint 10 stopped providing). It's an explicit devDependency here now; keep the two
  majors in step.
- **vitest** — only runs `shared/`'s own tests; a major is low-risk here, but keep it
  aligned with webapp's vitest when convenient so the two suites behave the same.

## 3. Verify — including the consumers

This is the part that's easy to skip and expensive to skip. `shared/`'s own checks:

```bash
task lint-shared     # eslint + tsc --noEmit
task test-shared
```

Then prove you didn't break the packages that compile this source:

```bash
task lint-webapp     # webapp's tsc type-checks shared/src via the file: link
task lint-mobile
task test-webapp
task test-mobile
```

If either consumer has stale `node_modules`, refresh the link first
(`cd webapp && npm install`) — `file:` dependencies are installed as a copy or symlink
depending on npm version, and a stale copy will happily type-check the old source and
tell you everything is fine.

## 4. Commit and describe

```
chore(shared): update devDependencies (typescript 6.0.3 -> 6.1.0, vitest 4.1.10 -> 4.2.0)
```

In the PR description list the version moves, note any major upgrades and what they
required, and state explicitly that webapp and mobile checks were run — that's the
non-obvious risk of touching this package.

## Doing a full repo sweep?

Order matters: **shared → webapp → mobile**. Updating shared first means the consumers'
`npm install` picks up the current source, and any fallout surfaces while you're still
looking at it rather than being blamed on an unrelated webapp bump. See
`update-webapp-deps` and `update-mobile-deps` for those.
