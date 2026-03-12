# Phase 5 — Real-Time Sync

## Goal

Connect the mobile app to the server's SSE event stream so that changes made on other clients (web app, another device) appear in real time without manual refresh. At the end of this phase the app stays in sync with the server while foregrounded.

---

## Prerequisites

- Phase 2 complete (notes list, note editor with TanStack Query)
- Phase 4 complete (sharing — so share/unshare events are meaningful)

---

## What to Build

### 1. New Files

```
mobile/src/
├── hooks/
│   └── useSSE.ts
└── api/
    └── events.ts        # SSE connection manager
```

### 2. Dependencies

| Package | Purpose |
|---------|---------|
| `react-native-sse` | SSE client for React Native (EventSource polyfill) |

If `react-native-sse` proves problematic, a lightweight alternative is a fetch-based SSE reader using `ReadableStream`.

### 3. SSE Connection (`src/api/events.ts`)

Manages the SSE connection to `GET /api/v1/events`:

- Opens the connection with the session cookie attached (same `Cookie: jot_session=<token>` header as other requests)
- Parses incoming `data:` lines as JSON `Event` objects
- Exposes an event emitter or callback interface:
  ```typescript
  type SSEEvent = {
    type: 'note_created' | 'note_updated' | 'note_deleted' | 'note_shared' | 'note_unshared';
    note_id: string;
    note: Note | null;
    source_user_id: string;
    target_user_id?: string;
  };
  ```
- Handles reconnection: if the connection drops, wait 3 seconds and reconnect
- Handles 401: if the server returns unauthorized, do not reconnect (session expired)

### 4. SSE Hook (`src/hooks/useSSE.ts`)

A React hook that:
- Starts the SSE connection when the user is authenticated
- On each event, invalidates the relevant TanStack Query cache:
  - `note_created` → invalidate notes list
  - `note_updated` → invalidate notes list + specific note query (if editor is open for that note)
  - `note_deleted` → invalidate notes list
  - `note_shared` → invalidate notes list (a new note appeared for the current user)
  - `note_unshared` → invalidate notes list (a note was removed from the current user's view)
- Skips events where `source_user_id` matches the current user (the local mutation already updated the cache via optimistic updates)
- Cleans up the connection on logout

### 5. App Lifecycle Management

Use React Native's `AppState` API:
- **Foreground** (`active`): open the SSE connection, do a full notes refetch to catch anything missed while backgrounded
- **Background** (`background`): close the SSE connection (saves battery, server drops idle connections anyway)
- **Inactive** (`inactive`): keep connection open (brief state during app switching)

Wire this into the `useSSE` hook or a top-level provider.

### 6. Integration Points

- Mount `useSSE()` in `App.tsx` or the `MainTabs` navigator (only when authenticated)
- The SSE hook interacts with TanStack Query's `queryClient.invalidateQueries()` — no changes needed to existing screens since they already react to query cache changes
- If the note editor is open and receives a `note_updated` event for the same note from another user, show a subtle toast: "This note was updated by another user" (avoid overwriting unsaved local edits — let the next save reconcile via last-write-wins)

---

## Server Endpoints Consumed

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/events` | SSE stream (long-lived connection) |

The server already sends these event types:
- `note_created`
- `note_updated`
- `note_deleted`
- `note_shared`
- `note_unshared`

No server changes required.

---

## Acceptance Criteria

- [ ] SSE connection is established on login / app foreground
- [ ] Creating a note on the web app makes it appear on the mobile app without manual refresh
- [ ] Editing a note on the web app updates it on the mobile app
- [ ] Deleting a note on the web app removes it from the mobile app's list
- [ ] Sharing a note with the mobile user makes it appear in their notes list
- [ ] Unsharing removes the note from the mobile user's list
- [ ] Events from the current user are ignored (no redundant refetches)
- [ ] SSE connection is closed when the app is backgrounded
- [ ] SSE connection is re-established when the app returns to foreground, with a catch-up refetch
- [ ] Connection drops are handled with automatic reconnection (3-second delay)
- [ ] Expired sessions (401) stop reconnection attempts and redirect to login
