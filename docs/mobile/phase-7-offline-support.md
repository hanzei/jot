# Phase 7 — Offline Support

## Goal

Enable the app to work without a network connection. Notes are cached locally in SQLite. Mutations made offline are queued and replayed when connectivity returns. At the end of this phase the app is fully usable offline with seamless sync.

---

## Prerequisites

- Phase 2 complete (notes CRUD)
- Phase 5 complete (SSE sync — needed for the online reconciliation path)

---

## What to Build

### 1. New Files

```
mobile/src/
├── db/
│   ├── schema.ts          # SQLite table definitions and migrations
│   ├── noteQueries.ts     # CRUD operations on local notes
│   └── syncQueue.ts       # Offline operation queue
├── hooks/
│   ├── useOfflineNotes.ts # Reads from local DB, syncs with server
│   └── useNetworkStatus.ts
└── components/
    └── OfflineBanner.tsx
```

### 2. Dependencies

| Package | Purpose |
|---------|---------|
| `expo-sqlite` | Local SQLite database |
| `@react-native-community/netinfo` | Network connectivity detection |

### 3. Local Database Schema (`src/db/schema.ts`)

Mirror the server schema locally:

```sql
-- Cached notes
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    note_type TEXT NOT NULL DEFAULT 'text',
    color TEXT NOT NULL DEFAULT '#ffffff',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    checked_items_collapsed INTEGER NOT NULL DEFAULT 0,
    is_shared INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    shared_with_json TEXT NOT NULL DEFAULT '[]'
);

-- Cached todo items
CREATE TABLE IF NOT EXISTS note_items (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    indent_level INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- Offline mutation queue
CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,    -- 'create', 'update', 'delete', 'restore', 'reorder', etc.
    endpoint TEXT NOT NULL,     -- full API path
    method TEXT NOT NULL,       -- 'POST', 'PUT', 'DELETE'
    body TEXT,                  -- JSON payload
    created_at TEXT NOT NULL
);
```

Labels and shared-with are stored as JSON strings on the note row to avoid complex join tables locally.

### 4. Sync Queue (`src/db/syncQueue.ts`)

When the app is offline and the user performs a mutation:
1. Apply the change to the local SQLite database immediately (optimistic)
2. Enqueue the operation in `sync_queue`

When connectivity is restored:
1. Drain the queue in order (FIFO)
2. For each operation, make the API call
3. On success, delete the queue entry
4. On conflict (e.g., 404 because the note was deleted on the server), discard the operation and log a warning
5. After draining, do a full refetch to reconcile

**Conflict resolution:** Last-write-wins. The server's `updated_at` is authoritative. After syncing queued operations, the full refetch from the server overwrites local state.

### 5. Offline-First Read Path (`src/hooks/useOfflineNotes.ts`)

Modify the data loading strategy:

1. **On load:** read from local SQLite first (instant render)
2. **If online:** fetch from server in background, update local DB, re-render with fresh data
3. **If offline:** local DB data is all that's shown

This replaces direct TanStack Query fetches for notes. TanStack Query can still be used, but its `queryFn` reads from local DB, and a background sync function updates the DB from the server.

### 6. Network Status Hook (`src/hooks/useNetworkStatus.ts`)

Uses `@react-native-community/netinfo`:
- Exposes `isConnected: boolean`
- On transition from offline → online:
  - Drain the sync queue
  - Re-establish SSE connection (Phase 5)
  - Full notes refetch
- On transition from online → offline:
  - Close SSE connection
  - Switch to local-only mode

### 7. Offline Banner (`OfflineBanner`)

A small persistent banner at the top of the screen when offline:
- "You're offline. Changes will sync when you reconnect."
- Dismiss button or auto-hide on reconnect
- Subtle color (yellow/amber)

### 8. Integration with Existing Screens

- `NotesListScreen`, `ArchivedScreen`, `TrashScreen` — read from local DB, background sync
- `NoteEditorScreen` — writes go to local DB + sync queue when offline
- Create note offline: generate the note ID locally (same 22-char random ID), queue the `POST`
- The sync queue must handle the case where a locally-created note's `POST` fails (e.g., conflict) — in that case, retry or surface an error

---

## Server Endpoints Consumed

No new endpoints. All existing endpoints are used through the sync queue. The key interactions:

| Operation | Endpoint | Offline behavior |
|-----------|----------|-----------------|
| List notes | `GET /api/v1/notes` | Read from local DB |
| Create note | `POST /api/v1/notes` | Write to local DB + queue |
| Update note | `PUT /api/v1/notes/{id}` | Write to local DB + queue |
| Delete note | `DELETE /api/v1/notes/{id}` | Write to local DB + queue |
| Restore note | `POST /api/v1/notes/{id}/restore` | Write to local DB + queue |
| Reorder | `POST /api/v1/notes/reorder` | Write to local DB + queue |

---

## Acceptance Criteria

- [ ] Notes load instantly from local cache (no loading spinner on subsequent launches)
- [ ] When online, server data is fetched in background and local DB is updated
- [ ] Creating a note while offline works — the note appears in the list immediately
- [ ] Editing a note while offline works — changes are saved locally
- [ ] Deleting a note while offline works — the note moves to trash locally
- [ ] When connectivity is restored, queued mutations are replayed in order
- [ ] After sync, a full refetch reconciles local state with the server
- [ ] Conflicts are resolved with last-write-wins (server state wins)
- [ ] An offline banner is shown when the device has no network
- [ ] The banner disappears when connectivity returns
- [ ] SSE reconnects automatically after coming back online
