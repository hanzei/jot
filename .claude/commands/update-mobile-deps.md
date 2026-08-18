---
description: Update npm dependencies in mobile/ — Expo, React Native, and the expo-* modules whose versions the Expo SDK dictates.
---

# Update mobile (Expo / React Native) dependencies

`mobile/` is an **Expo-managed** app on SDK 57. That changes the rules compared to
`webapp/`: for a large share of the dependency list, the correct version is not "latest",
it's "whatever this Expo SDK was built and tested against". Expo publishes that mapping,
and `npx expo install` is the tool that reads it.

The failure mode for getting this wrong is nasty — `npm install` succeeds, `npm test`
passes, TypeScript is happy, and the app red-screens or crashes on a real device, which
CI cannot see. So the version source of truth matters more here than the freshness.

## Two classes of dependency

**Expo-governed — never bump by hand.** `npx expo install --check` is the source of truth
here: it compares the installed tree against the versions this SDK was built against, so
run it rather than working from a remembered list. In practice it covers `expo`, `expo-*`,
`react`, `react-dom`, `react-native`, `@types/react`, `jest-expo`, `babel-preset-expo`, and
the native `react-native-*` modules Expo tracks (`react-native-gesture-handler`,
`react-native-reanimated`, `react-native-screens`, `react-native-safe-area-context`,
`react-native-svg`, `react-native-worklets`). The specifier style is a decent tell:
`~57.0.1` or an exact pin like `19.2.3` / `0.86.0` / `15.15.4`, rather than a caret range.

`@react-native/jest-preset` is a related but separate case — it's a React Native monorepo
package rather than an Expo one, so `expo install --check` may not report it, but it is
pinned to the React Native version (`0.86.1` against RN `0.86.0`) and must move with it.
Don't generalise that to the whole `@react-native/*` namespace; check each package against
the React Native version it's built for.

**Ordinary npm packages — bump normally.** `@react-navigation/*`,
`@tanstack/react-query`, `axios`, `i18next`, `react-i18next`, `lucide-react-native`,
`react-native-sse`, `react-native-markdown-display`, `react-native-reorderable-list`,
`expo-quick-actions` and `expo-share-intent` (community packages that version themselves,
despite the names), plus the dev tooling: `eslint`, `@typescript-eslint/*`, `typescript`,
`jest`, `@testing-library/react-native`.

`react-test-renderer` is a special case: it must exactly equal the `react` version, so it
moves only when Expo moves React.

`typescript` is in the ordinary list but is **not** a mobile-local decision: `shared/`,
`webapp/`, and `mobile/` are deliberately on the same range because both consumers
type-check `shared/src` with their own compiler. Take a TypeScript major across all three
together or leave it — a solo bump here is either pointless or breaks a sibling.

## Before you start

Feature branch, never `master` (root `CLAUDE.md`):

```bash
git status --short
git checkout -b chore/update-mobile-deps   # or the branch you were told to use
```

If `shared/` is part of the same sweep, do it first (`update-shared-deps`) — mobile
consumes it via `file:../shared`.

## 1. Fix the Expo-governed set

```bash
cd mobile
npx expo install --check     # reports packages that don't match SDK 57's expectations
npx expo install --fix       # moves them to the SDK-compatible versions
```

This is *not* an upgrade to the newest release — it's a convergence to the correct one,
and it can legitimately move a package **down**. If `--check` reports nothing, this half
of the job is already done; don't reach for `npm-check-updates` to "improve" on it.

An **Expo SDK major upgrade** (57 → 58) is a different, larger piece of work: it moves
React Native, the native module set, and often the Android/iOS config together, and it
needs device testing. Don't fold it into a routine dependency update. If that's what the
user actually wants, say so and treat it as its own change:
`npx expo install expo@^58 && npx expo install --fix`, then re-check `app.config.js`,
`app.json`, `metro.config.js`, `babel.config.js`, and the APK workflow.

## 2. Update the ordinary packages

```bash
npm outdated                                   # no extra tool to install; still queries the registry
npx npm-check-updates --filter '@react-navigation/*,@tanstack/react-query,axios,i18next,react-i18next,lucide-react-native,react-native-sse,react-native-markdown-display,react-native-reorderable-list,expo-quick-actions,expo-share-intent,eslint,@typescript-eslint/*,typescript,jest,@testing-library/react-native,@types/jest'
```

An explicit allow-list beats a reject pattern here — new Expo-governed packages get added
to this app over time, and an allow-list fails safe by ignoring them rather than
"helpfully" bumping them. If `npx npm-check-updates` can't be fetched, `npm outdated`
plus `npm install <pkg>@<version>` covers the same ground.

Apply in batches — minors together, each major on its own:

```bash
npx npm-check-updates -u --filter @react-navigation/drawer,@react-navigation/native,@react-navigation/native-stack && npm install
```

Keep the `@react-navigation/*` packages on the same major; they share internals and a
partial bump fails at runtime rather than at build time.

**ESLint here is on 9 while `shared/` is on 10.** The drift is harmless — separate
lockfiles, `node_modules`, and flat configs, and lint runs from this directory — and it's
forced rather than chosen: `eslint-plugin-react` and `eslint-plugin-react-hooks` don't
accept ESLint 10 at the versions pinned here. Check
`npm info eslint-plugin-react peerDependencies.eslint` before assuming that's still true.
When ESLint 10 does become possible, add `@eslint/js` as an explicit devDependency in the
same commit: `eslint.config.js` imports it but doesn't declare it, and under ESLint 9 that
only works because a transitive copy gets hoisted. The same omission in `shared/` broke CI
when it moved to 10 (#749).

Commit `package-lock.json` — CI installs with `npm ci`.

Re-run `npx expo install --check` afterwards. A community package can pull in a
peer-dependency range that drags an Expo-governed package off its pin; this is how the
two halves of the update interact and it's worth catching now.

## 3. The `overrides` block

`package.json` pins `js-yaml`, `markdown-it`, and `uuid` transitively to close advisories.
After upgrading, check whether each is still needed:

```bash
npm ls js-yaml markdown-it uuid
npm audit
```

If the tree already resolves to a safe version without the override, remove the entry and
reinstall. Stale overrides hold packages back invisibly. When you add one, record the
advisory in the PR description.

## 4. Verify

```bash
npm run lint
npm run typecheck        # tsc --noEmit; also type-checks shared/src via the file: link
npm test -- --ci         # jest
task check-mobile-expo   # expo-doctor; catches SDK/native mismatches nothing else will
```

`expo-doctor` is the highest-value check in this list — it's the one that knows about the
native side that Jest and tsc are blind to.

**This command is the only place it runs** — it is deliberately out of CI and `task check`,
since its expectations come from Expo's SDK manifest over the network and move without any
commit (the Taskfile comment above `check-mobile-expo` has the why). So nothing else will
catch SDK drift: run it even when the sweep looked like a no-op, and don't treat a clean
`expo install --check` in step 1 as a substitute — expo-doctor also covers native config,
Hermes regressions, and app-config schema errors.

The mobile test suite mocks the filesystem via `globalThis.mockFileSystem` in
`jest.setup.js` (see `mobile/CLAUDE.md`). If `expo-file-system` moved, confirm that mock
still matches the module's API surface rather than assuming green tests mean a working
`src/utils/fs.ts`.

### When native code is involved

If `expo install --fix` moved any native module, or `expo-doctor` flags the native
config, unit tests are not evidence the app works. Say so plainly in the PR description,
and where possible get a real build: the `mobile-apk.yml` workflow produces an APK and is
the cheapest available smoke test. Anything touching `expo-sqlite`, `expo-file-system`,
`expo-secure-store`, or `react-native-reanimated`/`react-native-worklets` deserves that
extra step, since they back offline persistence, credentials, and the animation runtime.

## 5. Commit and describe

```text
chore(mobile): update React Navigation to 7.14 and align expo-* with SDK 57
```

In the PR description: the version moves, which packages Expo moved and in which direction
(including any downgrades — they look alarming without an explanation), overrides added or
removed, `expo-doctor` result, and honestly what was and wasn't verified on a device or in
an APK build. Note anything held back, especially packages waiting on the next Expo SDK.

## Doing a full repo sweep?

Order is **shared → webapp → mobile** — both consumers compile `shared/src` directly, so
updating it first means fallout surfaces where it belongs. See `update-shared-deps` and
`update-webapp-deps`; `server/` is an independent Go module and can be done in any order.
