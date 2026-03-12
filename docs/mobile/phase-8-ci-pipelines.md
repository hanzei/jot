# Phase 8 — CI Pipelines

## Goal

Set up GitHub Actions workflows for the mobile app: linting, testing, and release APK builds. At the end of this phase every push that touches `mobile/` is automatically linted and tested, and tagged releases produce a signed APK artifact.

---

## Prerequisites

- Phase 1 complete (Expo project with `lint`, `typecheck`, and `test` scripts in `package.json`)
- A Firebase project with an Android app configured (for `google-services.json`)
- An Android signing keystore generated and stored as GitHub secrets

---

## What to Build

### 1. New Files

```
.github/workflows/
├── mobile-lint.yml
├── mobile-test.yml
└── mobile-apk.yml
```

### 2. Lint Workflow (`.github/workflows/mobile-lint.yml`)

Triggers on every push and pull request that touches `mobile/**`.

```yaml
name: Mobile — Lint
on:
  push:
    paths: ['mobile/**']
  pull_request:
    paths: ['mobile/**']
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: mobile/package-lock.json
      - run: npm ci
        working-directory: mobile
      - run: npm run lint
        working-directory: mobile
      - run: npm run typecheck
        working-directory: mobile
```

`package.json` scripts required:
- `"lint": "eslint src/ --ext .ts,.tsx"`
- `"typecheck": "tsc --noEmit"`

### 3. Test Workflow (`.github/workflows/mobile-test.yml`)

Triggers on every push and pull request that touches `mobile/**`.

```yaml
name: Mobile — Test
on:
  push:
    paths: ['mobile/**']
  pull_request:
    paths: ['mobile/**']
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: mobile/package-lock.json
      - run: npm ci
        working-directory: mobile
      - run: npm test -- --ci --coverage
        working-directory: mobile
      - uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: mobile/coverage/
```

`package.json` scripts required:
- `"test": "jest"` (with Jest configured for React Native via `jest-expo` preset)

### 4. APK Build Workflow (`.github/workflows/mobile-apk.yml`)

Triggers on pushes to `master` and on tags matching `v*`.

```yaml
name: Mobile — APK Build
on:
  push:
    branches: [master]
    tags: ['v*']
jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: mobile/package-lock.json

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Install dependencies
        run: npm ci
        working-directory: mobile

      - name: Write google-services.json
        run: echo "$GOOGLE_SERVICES_JSON" > mobile/google-services.json
        env:
          GOOGLE_SERVICES_JSON: ${{ secrets.GOOGLE_SERVICES_JSON }}

      - name: Write keystore
        run: echo "$KEYSTORE_BASE64" | base64 -d > mobile/android/app/release.keystore
        env:
          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}

      - name: Generate native Android project
        run: npx expo prebuild --platform android --clean
        working-directory: mobile

      - name: Build release APK
        run: ./gradlew assembleRelease
        working-directory: mobile/android
        env:
          ANDROID_KEYSTORE_PATH: ../release.keystore
          ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_STORE_PASSWORD: ${{ secrets.ANDROID_STORE_PASSWORD }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}

      - uses: actions/upload-artifact@v4
        with:
          name: jot-release-apk
          path: mobile/android/app/build/outputs/apk/release/app-release.apk
```

### 5. Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `GOOGLE_SERVICES_JSON` | Full contents of `google-services.json` from Firebase Console |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore (`base64 -w0 release.keystore`) |
| `ANDROID_KEY_ALIAS` | Alias of the signing key |
| `ANDROID_STORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_PASSWORD` | Key password |

Generate the keystore once:
```bash
keytool -genkey -v -keystore release.keystore -alias jot \
  -keyalg RSA -keysize 2048 -validity 10000
```

Never commit the keystore or `google-services.json` to the repository.

### 6. Taskfile Updates

Add mobile tasks to the root `Taskfile.yml`:

```yaml
test-mobile:
  dir: mobile
  cmds:
    - npm test

lint-mobile:
  dir: mobile
  cmds:
    - npm run lint
    - npm run typecheck
```

Update `task test` and `task lint` to also run mobile tasks if the `mobile/` directory exists.

---

## Acceptance Criteria

- [ ] Pushing changes to `mobile/` triggers the lint workflow
- [ ] Pushing changes to `mobile/` triggers the test workflow
- [ ] Lint workflow runs ESLint and TypeScript type checking
- [ ] Test workflow runs Jest and uploads a coverage artifact
- [ ] Pushing to `master` or tagging `v*` triggers the APK build workflow
- [ ] APK build produces a signed release APK as a workflow artifact
- [ ] All required secrets are documented
- [ ] `task lint-mobile` and `task test-mobile` work locally
