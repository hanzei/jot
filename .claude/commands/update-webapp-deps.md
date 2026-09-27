---
description: Update npm dependencies in webapp/ — React, Vite, Tailwind, ESLint, Vitest, Playwright, Workbox/PWA, and the security `overrides` block.
---

# Update webapp dependencies

`webapp/` is the largest npm surface in the repo and the one users see. It has three
things that make a blind `npm update` unreliable: a `file:../shared` link to
`@jot/shared`, security `overrides` that go stale once upstream ships a fix, and a
Playwright browser version that must match the installed `@playwright/test`.

Update in batches and verify after each, so a regression is attributable to one bump.

## Before you start

Feature branch, never `master` (root `CLAUDE.md`):

```bash
git status --short
git checkout -b chore/update-webapp-deps   # or the branch you were told to use
```

If `shared/` is being updated in the same sweep, do it first — see `update-shared-deps`.

## 1. Survey

```bash
cd webapp
npm outdated                   # no extra tool to install; still queries the registry
npx npm-check-updates          # reveals majors hidden behind satisfied ^ ranges
npm audit                      # relevant to the overrides block, see §4
```

Split what you find:

- **Patch/minor across the board** — one batch.
- **Framework majors** — React, Vite, Tailwind, ESLint, Vitest, React Router. One commit
  each, changelog read first.
- **Toolchain-coupled sets** — see below.
- **TypeScript** — not a webapp-local decision. `shared/`, `webapp/`, and `mobile/` are
  deliberately on the same range because both consumers type-check `shared/src` with their
  own compiler. Bump a TypeScript major across all three together, or not at all.

### Sets that move together

- **React**: `react`, `react-dom`, `@types/react`, `@types/react-dom` — same major, bumped
  together. `@testing-library/react` also tracks the React major.
- **Vite**: `vite`, `@vitejs/plugin-react`, `vite-plugin-pwa`, and `esbuild` (a direct
  dependency here, so it can drift from the one Vite resolves — check they agree).
- **Vitest**: `vitest` and `@vitest/coverage-v8` must share a major, or coverage silently
  fails to instrument.
  `jsdom` (the test environment) is held at 30.0.x: on 30.1 Vitest's
  `URL.createObjectURL` shim cannot find jsdom's Blob internals, so the image-upload tests
  in `useNoteImages`/`NoteModal` fail. Retry it when either side releases.
- **Tailwind**: `tailwindcss` and `@tailwindcss/vite` — same version. Tailwind v4 is
  CSS-config-first; a major bump means checking the `@import`/`@theme` blocks in the
  stylesheet, not just `package.json`.
- **ESLint**: `eslint` with `@typescript-eslint/*`, `eslint-plugin-react`,
  `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`. The plugins gate
  the ESLint major — bumping `eslint` ahead of them produces config-resolution errors
  rather than lint errors, so it looks like a broken config instead of a version problem.

  `shared/` is already on ESLint 10 while this package is on 9. The drift is harmless
  (separate lockfiles, separate `node_modules`, separate flat configs, lint always runs
  from the workspace directory) and it is not a stylistic choice — `eslint-plugin-react`
  holds this package back. Check the current peer range before assuming it's still true:

  ```bash
  npm info eslint-plugin-react peerDependencies.eslint
  ```

  At the versions pinned today, `eslint-plugin-react@7.37.5` accepts up to `^9.7`;
  `eslint-plugin-react-hooks@7.1.1` (`^9 || ^10`), `eslint-plugin-react-refresh`, and
  `@typescript-eslint@8.70` (`^8.57 || ^9 || ^10`) are already ESLint 10-ready. So ESLint
  10 lands here when — and only when — `eslint-plugin-react` publishes support.

  **When you do make that jump, bump `@eslint/js` in the same commit.** `eslint.config.js`
  imports it, and it is declared as a devDependency; keep it on the same major as
  `eslint`. ESLint 10 no longer provides it transitively, and an undeclared copy in
  `shared/` broke CI (#749). `mobile/` still has that latent gap.
- **Workbox**: every `workbox-*` package plus `vite-plugin-pwa` — mismatched Workbox
  versions produce a service worker that builds but fails at runtime, which unit tests
  will not catch. After any Workbox or PWA change, run `npm run build` and confirm the
  generated service worker is emitted.

## 2. Apply

```bash
npx npm-check-updates -u --target minor && npm install
# then majors one at a time:
npx npm-check-updates -u --filter vite,@vitejs/plugin-react,vite-plugin-pwa && npm install
```

`npm install` re-links `@jot/shared`; never edit that entry's `file:../shared` specifier.

Run these with Node 24's npm (11). npm 10 fails with `ERESOLVE ... Conflicting peer
dependency: @babel/core@8` on any `@vitejs/plugin-react` change: it resolves the plugin's
optional `@rolldown/plugin-babel` peer chain against Babel 8 even though none of it is
installed. `npx -y npm@11 install ...` works if your local Node is older.

Commit `package-lock.json` — CI uses `npm ci` and fails on lockfile drift.

## 3. Verify after every batch

```bash
npm run lint          # eslint
npm run lint:ts       # tsc --noEmit — also type-checks shared/src through the file: link
npm run test:run      # vitest
npm run build         # catches Vite/Tailwind/PWA breakage that tests miss
```

Then the browser path, which is the only thing that exercises the real bundle:

```bash
npx playwright install chromium   # required if @playwright/test moved
task test-e2e
```

`npx playwright` resolves to the `@playwright/test` binary in `node_modules/.bin`, so the
browser it downloads matches the version in the lockfile — that pairing is the point, and
it breaks if you run a globally installed Playwright instead.

`task check-translations` is unaffected by dependency work but is cheap; run it if
i18next or react-i18next moved.

## 4. The `overrides` block

`package.json` may carry an `overrides` block pinning transitive versions to close
advisories. None is needed today — the last three (`serialize-javascript`, `minimatch`,
`brace-expansion`) were dropped once every resolved copy was a patched release. When one
exists, it is there because a *direct* dependency hadn't yet released a fix; after
upgrading, check whether each is still doing work with `npm ls <package>`.

If the resolved tree already satisfies the safe version without the override, remove that
entry, re-run `npm install`, and confirm `npm audit` stays clean. Stale overrides are worse
than no overrides — they silently hold a package back and hide the real dependency graph.
When adding a new one, put the advisory or the reason in the PR description.

## 5. Node version

The webapp builds on Node 24 (`Dockerfile` `node:24-alpine`, all CI workflows
`node-version: "24"`, README prerequisites). If a dependency raises its `engines`
requirement above that, the Docker build fails long after CI passes — bump every one of
those places in the same commit, or hold the dependency back.

## 6. Commit and describe

One commit per batch:

```text
chore(webapp): update Vite to 8.1.0 and vite-plugin-pwa to 1.4.0
```

In the PR description: every direct dependency that moved with old → new, majors called
out separately with what changed and any code you adapted, overrides added or removed with
the reason, and confirmation that `npm run build` and the e2e suite passed. Note anything
deliberately held back and why.

If a bump changes user-visible behaviour (PWA/offline caching, routing, markdown or
sanitisation via `marked`/`dompurify`), flag it — `dompurify` in particular is a security
boundary, so a major there deserves an explicit note about what changed in its sanitiser
defaults.

## Doing a full repo sweep?

Order is **shared → webapp → mobile**, because both consumers compile `shared/src`
directly. `update-shared-deps` and `update-mobile-deps` cover the other two; `server/` is
an independent Go module and can be done in any order.
