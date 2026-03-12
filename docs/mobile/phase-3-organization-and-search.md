# Phase 3 — Organization & Search

## Goal

Implement the archive and trash tabs, note pinning, color picker, label picker, search, and the long-press context menu. At the end of this phase the user has full organizational control over their notes.

---

## Prerequisites

- Phase 2 complete (notes list, note editor, NoteCard, API functions)

---

## What to Build

### 1. New Files

```
mobile/src/
├── screens/
│   ├── ArchivedScreen.tsx     # replace placeholder
│   └── TrashScreen.tsx        # replace placeholder
├── components/
│   ├── ColorPicker.tsx
│   ├── LabelPicker.tsx
│   └── NoteContextMenu.tsx
├── hooks/
│   └── useLabels.ts
└── api/
    └── labels.ts
```

### 2. Archived Screen

- Same card layout as Notes List (reuse `NoteCard`)
- Fetches notes with `GET /api/v1/notes?archived=true`
- Pull-to-refresh
- Search bar (calls `GET /api/v1/notes?archived=true&search=...`)
- No FAB (cannot create notes in archive view)
- No drag-to-reorder
- Long-press context menu with: **Unarchive**, **Move to Trash**

### 3. Trash Screen

- Same card layout, read-only (tapping a card does **not** open the editor)
- Fetches notes with `GET /api/v1/notes?trashed=true`
- Banner at the top: "Items in Trash are automatically deleted after 7 days"
- Pull-to-refresh
- No FAB, no drag-to-reorder
- Long-press context menu with: **Restore**, **Delete Permanently**
- Restore calls `POST /api/v1/notes/{id}/restore`
- Permanent delete calls `DELETE /api/v1/notes/{id}/permanent` (with a confirmation dialog)

### 4. Context Menu (`NoteContextMenu`)

Triggered by long-press on a `NoteCard`. Implemented as a bottom sheet or popup menu.

**Actions per view:**

| Action | Notes List | Archived | Trash |
|--------|-----------|----------|-------|
| Pin / Unpin | Yes | — | — |
| Archive | Yes | — | — |
| Unarchive | — | Yes | — |
| Move to Trash | Yes | Yes | — |
| Restore | — | — | Yes |
| Delete Permanently | — | — | Yes |
| Change Color | Yes | — | — |
| Share | Yes | — | — |

The menu receives the current view context and note, and renders the appropriate actions.

### 5. Pin / Unpin

- Toggle via `PUT /api/v1/notes/{id}` with `{ pinned: true/false }`
- On the notes list, pinned notes appear in a **Pinned** section; unpinned in **Others**
- Available from the context menu and the note editor toolbar

### 6. Color Picker (`ColorPicker`)

A horizontal scroll row of colored circles. Use the same palette as the webapp.

- Tapping a color calls `PUT /api/v1/notes/{id}` with `{ color: "#hex" }`
- The currently active color shows a checkmark overlay
- Presented as a bottom sheet from the context menu or the note editor toolbar

**Palette** (match the webapp — check `webapp/src/components/` for the exact hex values):
```
#ffffff, #f28b82, #fbbc04, #fff475, #ccff90,
#a7ffeb, #cbf0f8, #aecbfa, #d7aefb, #fdcfe8,
#e6c9a8, #e8eaed
```

### 7. Label Picker (`LabelPicker`)

A bottom sheet with:
- List of the user's existing labels, each with a checkbox (checked = applied to this note)
- "New label" text field with an add button
- Tapping a label toggles it:
  - Add: `POST /api/v1/notes/{id}/labels` with `{ name: "label name" }`
  - Remove: `DELETE /api/v1/notes/{id}/labels/{label_id}`

**Labels hook** (`useLabels`):
- `useLabels()` — fetches all user labels via `GET /api/v1/labels`

Accessible from the note editor toolbar and the context menu.

### 8. Label Filtering

On the Notes List screen, add a horizontal scroll row of label chips below the search bar.
- Tapping a label chip filters notes: `GET /api/v1/notes?label={label_id}`
- Tapping the active label again clears the filter
- An "All" chip at the start clears the filter

### 9. Search

The search bar at the top of Notes List, Archived, and Trash screens:
- On submit (keyboard "search" action), calls the notes API with `search` query param
- Clear button resets to unfiltered list
- Debounce input by 300ms for a responsive feel

### 10. Note Editor Toolbar Updates

Add buttons to the note editor toolbar from Phase 2:
- **Color** — opens ColorPicker
- **Label** — opens LabelPicker
- **Archive** / **Unarchive** — toggles `archived` via `PUT /api/v1/notes/{id}`
- **Pin** / **Unpin** — toggles `pinned`
- **Delete** — moves to trash (already from Phase 2)

---

## Server Endpoints Consumed

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/notes?archived=true` | List archived notes |
| GET | `/api/v1/notes?trashed=true` | List trashed notes |
| GET | `/api/v1/notes?search=...` | Search notes |
| GET | `/api/v1/notes?label={id}` | Filter by label |
| PUT | `/api/v1/notes/{id}` | Update pin/archive/color |
| POST | `/api/v1/notes/{id}/restore` | Restore from trash |
| DELETE | `/api/v1/notes/{id}/permanent` | Permanently delete |
| GET | `/api/v1/labels` | List user's labels |
| POST | `/api/v1/notes/{id}/labels` | Add label to note |
| DELETE | `/api/v1/notes/{id}/labels/{label_id}` | Remove label from note |

---

## Acceptance Criteria

- [ ] Archived tab shows only archived notes
- [ ] Trash tab shows only trashed notes with a 7-day deletion banner
- [ ] Trashed notes are read-only (no editor on tap)
- [ ] Long-press on a note card opens a context menu with view-appropriate actions
- [ ] Pin/unpin works and updates the notes list sections
- [ ] Color picker shows the palette; selecting a color updates the note
- [ ] Label picker shows existing labels with checkboxes; toggling works
- [ ] New labels can be created inline from the label picker
- [ ] Label filter row appears on the notes list; tapping filters notes
- [ ] Search works across notes list, archived, and trash views
- [ ] Archive/unarchive moves notes between the Notes and Archived tabs
- [ ] Restore moves notes from Trash back to the Notes tab
- [ ] Permanent delete removes notes with a confirmation dialog
- [ ] Note editor toolbar has color, label, pin, archive, and delete actions
