# Jot React Native Mobile App — Proposal

## Overview

This document proposes a React Native mobile client for Jot. The app targets **Android** and connects to an existing Jot server via the same REST API the web app uses. The server uses cookie-based sessions (`jot_session`); the mobile app extracts the session token from the login response and stores it in `expo-secure-store`, attaching it as a `Cookie` header on all requests. Push notification support requires minor additions to the server (device token storage and FCM dispatch); all other backend routes are consumed as-is.

The scope of this proposal covers the core note-taking experience. Settings and admin features are explicitly out of scope.

---

## Goals

- Give users a native Android experience for creating, editing, and organizing notes
- Support both text notes and todo lists
- Keep the app in sync with the server (and other clients) in real time
- Work offline with automatic sync when connectivity is restored
- Match the visual feel of the existing web app (colors, labels, pinning)
- Deliver push notifications for share and collaboration events via Firebase Cloud Messaging (FCM)

---

## Out of Scope

- Settings page (theme, language, password, profile)
- Admin panel (user management, role changes)
- Google Keep import

---

## Screens & Navigation

Navigation uses a bottom tab bar with three primary tabs. A stack navigator lives inside each tab.

```
Root
├── Auth Stack (unauthenticated)
│   ├── Login
│   └── Register
└── Main Tabs (authenticated)
    ├── Notes Tab
    │   ├── Notes List
    │   ├── Note Editor  (modal / full-screen)
    │   └── Share Sheet  (modal)
    ├── Archived Tab
    │   └── Archived List
    └── Trash Tab
        └── Trash List
```

A floating action button (FAB) on the Notes List screen opens the Note Editor to create a new note.

---

## Screen Details

### Login
- Username and password fields
- "Sign in" button
- Link to Register
- Error message for invalid credentials
- On success, extract the `jot_session` token from the `Set-Cookie` response header and persist it in `expo-secure-store` (Android Keystore-backed)
- The axios instance attaches the token as a `Cookie: jot_session=<token>` header on every subsequent request
- After login, the current FCM device token is registered with the server (`POST /api/v1/devices`)

### Register
- Username, first name, last name, password fields
- "Create account" button
- Redirects to Notes List on success

### Notes List
- Masonry or single-column card grid (user-togglable)
- Sections: **Pinned** (if any pinned notes exist), **Other**
- Each card shows: title, content preview / todo item preview, color strip, label chips, share avatars
- Pull-to-refresh
- Search bar at the top (calls `GET /notes?search=`)
- Label filter row (horizontal scroll of label chips)
- Long-press on a card opens a context menu: Pin/Unpin, Archive, Move to Trash, Change Color, Share
- Drag-to-reorder via `react-native-gesture-handler` + `react-native-reanimated` (calls `POST /notes/reorder`)
- FAB opens Note Editor in "create" mode

### Note Editor
- Full-screen modal (swipe-down to dismiss)
- Title field (max 200 chars)
- **Text note**: multiline content field (max 10 000 chars)
- **Todo note**:
  - List of checkbox rows, each editable inline
  - "Add item" row at the bottom
  - Swipe-to-delete on individual items
  - Drag handles to reorder items
  - Completed items section (collapsible, toggle with chevron)
- Note type toggle in the toolbar (text ↔ todo) — only when creating
- Toolbar actions: Color picker, Label picker, Archive, Share, Delete
- Auto-save with a short debounce (1 s) via `PUT /notes/{id}`
- New note is created (`POST /notes`) on first keystroke

### Share Sheet
- Opened from Note Editor toolbar or card context menu
- Search field for username lookup (`GET /users?search=`)
- List of matching users with avatar + name
- Tap a user to share (`POST /notes/{id}/share`)
- Current shares listed below with a remove button (`DELETE /notes/{id}/share`)

### Archived List
- Same card layout as Notes List, minus drag-to-reorder and FAB
- Pull-to-refresh
- Search works the same way (`GET /notes?archived=true&search=`)
- Card context menu: Unarchive, Move to Trash

### Trash List
- Same card layout, read-only (no editing)
- Card context menu: Restore, Delete Permanently
- Banner at top: "Items in Trash are deleted after 30 days"

---

## Color Picker

A horizontal scroll row of colored circles (matching the web app palette). Tapping one calls `PUT /notes/{id}` with the new color. The current color shows a checkmark.

---

## Label Picker

A bottom sheet with:
- List of existing labels, each with a checkbox (checked if applied to the note)
- "New label" text field + add button
- Tapping a label toggles it via `POST /notes/{id}/labels` or `DELETE /notes/{id}/labels/{labelId}`

---

## Real-Time Sync

The server exposes `GET /api/v1/events` as a Server-Sent Events stream. React Native doesn't support the browser `EventSource` API natively, so we use the `react-native-sse` package (or a lightweight fetch-based SSE client) to maintain this connection while the app is foregrounded.

On receiving an event, the relevant note is re-fetched or the local cache is updated. When the app is backgrounded the connection is dropped and re-established on foreground.

---

## Push Notifications (FCM)

### Overview

Push notifications are delivered via Firebase Cloud Messaging (FCM). The mobile app registers a device token with the Jot server on login; the server calls the FCM HTTP v1 API to push messages when relevant events occur.

### Notification triggers

| Event | Recipient(s) | Notification text |
|---|---|---|
| Note shared with you | The invited user | "`{owner}` shared a note with you: `{note title}`" |
| Shared note edited | All collaborators except the editor | "`{editor}` updated `{note title}`" |
| Share removed | The removed user | "Your access to `{note title}` was removed" |

Edits are debounced on the server (30 s) so rapid keystrokes don't flood recipients.

### Mobile-side changes

1. On first launch, request the `POST_NOTIFICATIONS` permission (Android 13+).
2. Call `Notifications.getExpoPushTokenAsync()` / `getDevicePushTokenAsync()` to obtain the FCM token.
3. After login, `POST /api/v1/devices` with the token and platform (`android`).
4. On logout, `DELETE /api/v1/devices/{token}` to stop receiving notifications.
5. A foreground notification handler shows an in-app banner; tapping a notification deep-links to the relevant note.

### Server-side changes required

These are the only backend additions needed:

**New table — `device_tokens`**
```sql
CREATE TABLE device_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    platform    TEXT NOT NULL DEFAULT 'android',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**New endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/devices` | Yes | Register a device token |
| DELETE | `/api/v1/devices/{token}` | Yes | Unregister a device token |

**Notification dispatch** — a small internal `notifier` package wraps the FCM HTTP v1 API. It is called from within the existing share and note-update handlers. The server must be configured with a Firebase service account JSON (new environment variable `FIREBASE_CREDENTIALS_FILE`).

### Firebase project setup

1. Create a Firebase project in the Google Firebase Console.
2. Add an Android app with the app's package name (e.g. `com.example.jot`).
3. Download `google-services.json` and place it in `mobile/` — Expo picks it up automatically.
4. Generate a service account key (Project Settings → Service Accounts) and set `FIREBASE_CREDENTIALS_FILE` on the server.

---

## Offline Support

- All fetched notes are stored in a local SQLite database via `expo-sqlite`
- Mutations made offline are queued in an operations table
- When connectivity is restored the queue is drained in order
- Conflict resolution: last-write-wins (server timestamp wins on pull)
- The Notes List renders from the local cache first, then reconciles with the server response

---

## Tech Stack

| Concern | Library |
|---|---|
| Framework | React Native (via Expo managed workflow) |
| Navigation | React Navigation 7 (native stack + bottom tabs) |
| HTTP client | axios (shared patterns with the web app) |
| Async state | TanStack Query (caching, background refetch, optimistic updates) |
| Offline storage | expo-sqlite |
| Gestures | react-native-gesture-handler |
| Animations | react-native-reanimated |
| Drag-and-drop | react-native-draggable-flatlist |
| SSE | react-native-sse |
| Session storage | expo-secure-store (persists `jot_session` cookie value) |
| Push notifications | expo-notifications + Firebase (FCM) |
| Icons | @expo/vector-icons (Heroicons subset) |
| Styling | StyleSheet API + a theme context for light/dark |

Expo is chosen to simplify the build pipeline and OTA updates. The managed workflow supports `expo-notifications` which uses FCM on Android without requiring the full `@react-native-firebase` suite.

---

## Shared Code with the Web App

The TypeScript interfaces in `webapp/src/types/index.ts` (Note, NoteItem, Label, NoteShare, User, etc.) can be extracted into a shared package (`packages/types`) and consumed by both the web app and the mobile app without modification. The API call signatures are also directly portable since both clients use axios.

---

## Accessibility

- All interactive elements have `accessibilityLabel` and `accessibilityRole` props
- Color is never the sole indicator of state (labels show text, not just a dot)
- Minimum touch target size: 48 × 48 dp (Android Material guideline)
- Font scaling respects the system text size preference via `allowFontScaling`
- TalkBack support via standard React Native accessibility props

---

## Directory Structure

```
mobile/
├── app.json            # Expo config
├── App.tsx             # Root component, navigation container
├── src/
│   ├── navigation/     # Stack and tab navigators
│   ├── screens/        # One file per screen
│   │   ├── LoginScreen.tsx
│   │   ├── RegisterScreen.tsx
│   │   ├── NotesListScreen.tsx
│   │   ├── NoteEditorScreen.tsx
│   │   ├── ShareScreen.tsx
│   │   ├── ArchivedScreen.tsx
│   │   └── TrashScreen.tsx
│   ├── components/     # Reusable UI pieces
│   │   ├── NoteCard.tsx
│   │   ├── TodoItem.tsx
│   │   ├── ColorPicker.tsx
│   │   ├── LabelPicker.tsx
│   │   └── UserAvatar.tsx
│   ├── hooks/          # Custom hooks (useNotes, useAuth, useSync)
│   ├── api/            # axios instance + per-resource functions
│   ├── db/             # expo-sqlite schema and queries
│   ├── store/          # Zustand or Context for auth state
│   └── types/          # Re-exports from shared package
├── e2e/                # Detox end-to-end tests
└── __tests__/          # Jest + React Native Testing Library
```

---

## CI Pipeline

CI runs on GitHub Actions. Three workflows cover the mobile app; they live under `.github/workflows/` alongside the existing server and webapp workflows.

### `mobile-lint.yml` — Lint

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
      - run: npm run lint        # eslint + typescript-eslint
        working-directory: mobile
      - run: npm run typecheck   # tsc --noEmit
        working-directory: mobile
```

The `lint` and `typecheck` scripts are defined in `mobile/package.json`.

---

### `mobile-test.yml` — Unit & Integration Tests

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

---

### `mobile-apk.yml` — Release APK Build

Triggers on pushes to `master` and on tags matching `v*`. Produces a signed release APK as a workflow artifact. The build uses Expo's local Android build (no EAS cloud required for CI), which runs `./gradlew assembleRelease` inside the managed workflow's generated Android project.

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
        run: |
          echo "$KEYSTORE_BASE64" | base64 -d > mobile/android/app/release.keystore
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

**Required GitHub secrets**

| Secret | Description |
|---|---|
| `GOOGLE_SERVICES_JSON` | Full contents of `google-services.json` from Firebase Console |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore file |
| `ANDROID_KEY_ALIAS` | Alias of the signing key inside the keystore |
| `ANDROID_STORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_PASSWORD` | Key password |

The keystore is generated once (`keytool -genkey -v -keystore release.keystore -alias jot -keyalg RSA -keysize 2048 -validity 10000`) and stored securely — never committed to the repository.

---

## Testing Plan

| Layer | Tool | Coverage |
|---|---|---|
| Unit | Jest + React Native Testing Library | Hooks, utility functions, individual components |
| Integration | Jest + MSW (mock service worker) | Screen-level flows against a mocked API |
| E2E | Detox | Login → create note → add todo → share → archive → trash |

---

## Open Questions

1. **Biometric auth** — should the app support fingerprint unlock (Android BiometricPrompt) as an alternative to entering credentials on re-open?
2. **Notification opt-out granularity** — should users be able to mute notifications per note (e.g. for a busy shared note), or is a global on/off toggle in the OS settings enough?
3. **Minimum Android version** — Android 10 (API 29) is a reasonable baseline covering ~95% of active devices; confirm with stakeholders. `POST_NOTIFICATIONS` permission is only required from Android 13 (API 33).
4. **Expo Go vs development build** — `react-native-reanimated` and `expo-notifications` both require a development build rather than Expo Go; the team needs the Expo EAS CLI configured locally for development.
