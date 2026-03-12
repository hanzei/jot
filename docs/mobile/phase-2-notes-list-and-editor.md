# Phase 2 — Notes List & Note Editor

## Goal

Implement the core note-taking experience: viewing notes in a card grid and creating/editing both text notes and todo notes. At the end of this phase a user can create, view, edit, and delete notes from the mobile app.

---

## Prerequisites

- Phase 1 complete (Expo project, auth, navigation, API client)

---

## What to Build

### 1. New Files

```
mobile/src/
├── screens/
│   ├── NotesListScreen.tsx    # replace placeholder
│   └── NoteEditorScreen.tsx
├── components/
│   ├── NoteCard.tsx
│   └── TodoItem.tsx
├── hooks/
│   └── useNotes.ts
└── api/
    └── notes.ts               # note-specific API functions
```

### 2. API Functions (`src/api/notes.ts`)

| Function | Endpoint | Notes |
|----------|----------|-------|
| `getNotes(params)` | `GET /api/v1/notes` | Params: `archived`, `search`, `trashed`, `label` |
| `getNote(id)` | `GET /api/v1/notes/{id}` | |
| `createNote(data)` | `POST /api/v1/notes` | Body: `{ title, content, note_type }` |
| `updateNote(id, data)` | `PUT /api/v1/notes/{id}` | Partial update |
| `deleteNote(id)` | `DELETE /api/v1/notes/{id}` | Soft-delete (moves to trash) |

### 3. Notes Hook (`src/hooks/useNotes.ts`)

Uses TanStack Query (add `@tanstack/react-query` dependency) for:
- `useNotes(params)` — fetches and caches the notes list, supports background refetch
- `useNote(id)` — fetches a single note
- `useCreateNote()` — mutation, invalidates notes list on success
- `useUpdateNote()` — mutation with optimistic update
- `useDeleteNote()` — mutation, invalidates notes list on success

Wrap the app in a `QueryClientProvider` in `App.tsx`.

### 4. Notes List Screen

**Layout:**
- Search bar at the top (text input, filters locally or calls API with `search` param on submit)
- Two sections when pinned notes exist: **Pinned** header, then **Others** header
- Single-column card layout (masonry is a stretch goal)
- Each card rendered by `NoteCard` component
- Floating Action Button (FAB) in bottom-right corner → opens Note Editor in create mode
- Pull-to-refresh via `RefreshControl`

**NoteCard component:**
- Colored left border or background tint matching `note.color`
- Title (bold, truncated to 1 line)
- Content preview (truncated to 3 lines) for text notes
- Checkbox item preview (first 3–5 items) for todo notes
- Label chips (horizontal row, small pills)
- Share indicator if `note.shared_with` is non-empty
- Tap → opens Note Editor for that note
- Long-press → shows context menu (implemented in Phase 3)

### 5. Note Editor Screen

Presented as a full-screen modal (stack navigator with `presentation: 'modal'`).

**Common elements:**
- Title text input (max 200 characters)
- Toolbar at the bottom with action buttons (color, labels, archive, share, delete — most wired in later phases; for now, just a delete button)
- Back/dismiss button in header
- Auto-save: debounce updates by 1 second, call `PUT /notes/{id}` on change
- New note: call `POST /notes` on first keystroke, then switch to update mode with the returned ID

**Text note mode:**
- Multiline content text input below the title (max 10,000 characters)

**Todo note mode:**
- List of `TodoItem` components, each with:
  - Checkbox (toggle `completed`)
  - Editable text input
  - Delete button (or swipe-to-delete)
- "Add item" row at the bottom
- Completed items section (collapsible with a chevron toggle, respects `checked_items_collapsed`)
- Items ordered by `position`

**Note type toggle:**
- Only visible when creating a new note (not when editing)
- Toggle between text and todo in the toolbar or header

**TodoItem component:**
- Checkbox + inline text input
- Completed items show strikethrough text styling
- Indent level visual offset (based on `indent_level` field)

### 6. Data Flow

```
NotesListScreen
  └── useNotes({ archived: false, trashed: false })
       └── GET /api/v1/notes
  └── NoteCard (tap) → navigate to NoteEditorScreen with { noteId }
  └── FAB (tap) → navigate to NoteEditorScreen with { noteId: null }

NoteEditorScreen
  ├── noteId is null → create mode
  │   └── on first edit → POST /api/v1/notes → receive ID → switch to edit mode
  └── noteId is set → edit mode
      └── useNote(noteId) → load existing data
      └── on change (debounced 1s) → PUT /api/v1/notes/{id}
```

---

## Server Endpoints Consumed

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/notes` | List notes (active, not archived, not trashed) |
| GET | `/api/v1/notes/{id}` | Get single note with items, shares, labels |
| POST | `/api/v1/notes` | Create note |
| PUT | `/api/v1/notes/{id}` | Update note (title, content, items, etc.) |
| DELETE | `/api/v1/notes/{id}` | Soft-delete (move to trash) |

---

## Acceptance Criteria

- [ ] Notes list displays all active (non-archived, non-trashed) notes as cards
- [ ] Pinned notes appear in a separate "Pinned" section above "Others"
- [ ] Note cards show title, content preview, color, and label chips
- [ ] Todo note cards show checkbox item previews
- [ ] Tapping a card opens the note editor with that note's data
- [ ] FAB creates a new note and opens the editor
- [ ] Text notes can be edited (title + content)
- [ ] Todo notes can be edited (add/remove/check items, edit text)
- [ ] Note type can be toggled when creating (not when editing)
- [ ] Changes auto-save with a 1-second debounce
- [ ] Completed todo items are collapsible
- [ ] Pull-to-refresh reloads the notes list
- [ ] Delete button moves a note to trash
- [ ] Empty state shown when no notes exist
