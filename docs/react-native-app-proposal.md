# Jot React Native Mobile App — Proposal

## Overview

This document proposes a React Native mobile client for Jot. The app targets iOS and Android and connects to an existing Jot server via the same REST API the web app uses. No backend changes are required.

The scope of this proposal covers the core note-taking experience. Settings and admin features are explicitly out of scope.

---

## Goals

- Give users a native mobile experience for creating, editing, and organizing notes
- Support both text notes and todo lists
- Keep the app in sync with the server (and other clients) in real time
- Work offline with automatic sync when connectivity is restored
- Match the visual feel of the existing web app (colors, labels, pinning)

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
- JWT token stored in `SecureStore` (Expo) or Keychain (bare RN)

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
| Drag-and-drop | @shopify/draggable or react-native-draggable-flatlist |
| SSE | react-native-sse |
| Secure token storage | expo-secure-store |
| Icons | @expo/vector-icons (Heroicons subset) |
| Styling | StyleSheet API + a theme context for light/dark |

Expo is chosen to simplify the build pipeline and OTA updates. The managed workflow is sufficient because there are no unusual native modules.

---

## Shared Code with the Web App

The TypeScript interfaces in `webapp/src/types/index.ts` (Note, NoteItem, Label, NoteShare, User, etc.) can be extracted into a shared package (`packages/types`) and consumed by both the web app and the mobile app without modification. The API call signatures are also directly portable since both clients use axios.

---

## Accessibility

- All interactive elements have `accessibilityLabel` and `accessibilityRole` props
- Color is never the sole indicator of state (labels show text, not just a dot)
- Minimum touch target size: 44 × 44 pt
- Dynamic Type support on iOS via `allowFontScaling`

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

## Testing Plan

| Layer | Tool | Coverage |
|---|---|---|
| Unit | Jest + React Native Testing Library | Hooks, utility functions, individual components |
| Integration | Jest + MSW (mock service worker) | Screen-level flows against a mocked API |
| E2E | Detox | Login → create note → add todo → share → archive → trash |

---

## Open Questions

1. **Biometric auth** — should the app support Face ID / fingerprint unlock as an alternative to typing credentials on re-open?
2. **Push notifications** — the server has no push infrastructure today; would real-time notifications for shared note edits be in scope for a later phase?
3. **Minimum OS targets** — iOS 16+ and Android 10+ is a reasonable baseline; confirm with stakeholders.
4. **Expo Go vs development build** — native modules like `react-native-reanimated` require a development build rather than Expo Go; the team needs the Expo EAS CLI set up.
