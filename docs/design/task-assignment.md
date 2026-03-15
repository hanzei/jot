# Design: Todo Item Assignment

**Status:** Proposal  
**Author:** Design Agent  
**Date:** 2026-03-15

---

## Summary

Allow users to assign individual todo items to people who have access to the note (the owner and anyone the note is shared with). This turns shared to-do lists into lightweight collaborative task boards without adding heavyweight project-management overhead.

---

## Motivation

Shared to-do notes currently let multiple people see and edit items, but there is no way to indicate *who* is responsible for a given item. Users resort to conventions like prepending names ("Alice: buy milk"), which are error-prone and unstructured. First-class assignments solve this cleanly.

---

## Scope

**In scope (V1):**

- Assign a single user to any uncompleted todo item.
- Display the assignee inline in the note editor and on the card preview.
- Assignee picker limited to users who have access to the note.
- Persist and sync assignments via the existing note update flow.
- Real-time sync via existing SSE `note_updated` events.
- Clear assignments when a user is unshared from the note.

**Out of scope (V1):**

- Multiple assignees per item.
- Due dates, priority, or other task-management metadata.
- "Assigned to me" filter / view.
- Push notifications for assignment changes.
- Mobile app changes (API is consumed; UI deferred).

---

## Technical Design

### 1. Database

#### Migration `014_add_item_assignment.sql`

```sql
ALTER TABLE note_items ADD COLUMN assigned_to_user_id TEXT DEFAULT NULL
    REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_note_items_assigned_to ON note_items(assigned_to_user_id);
```

**Rationale:**

- A nullable FK column on `note_items` is the simplest change. `ON DELETE SET NULL` means if a user account is deleted, assignments become unassigned rather than cascading item deletion.
- A junction table (`note_item_assignments`) was considered for multi-assign but rejected for V1 — single assignment covers the typical use case. Upgrading to a junction table later is straightforward.
- An index on `assigned_to_user_id` supports a future "assigned to me" query efficiently.

**Prerequisite:** SQLite foreign key enforcement must be enabled (`PRAGMA foreign_keys = ON`) for `ON DELETE SET NULL` to take effect. Verify the database bootstrap enables this pragma; if not, add it to `internal/database` initialization.

#### Clearing assignments on unshare

When a user is unshared from a note, all their item assignments within that note must be cleared:

```sql
UPDATE note_items SET assigned_to_user_id = NULL
WHERE note_id = ? AND assigned_to_user_id = ?;
```

This query runs inside `NoteStore.UnshareNote` or as a follow-up call from the handler, within the same request.

---

### 2. Go Models

#### `NoteItem` struct changes

```go
type NoteItem struct {
    ID               string    `json:"id"`
    NoteID           string    `json:"note_id"`
    Text             string    `json:"text"`
    Completed        bool      `json:"completed"`
    Position         int       `json:"position"`
    IndentLevel      int       `json:"indent_level"`
    AssignedToUserID *string   `json:"assigned_to_user_id"`
    CreatedAt        time.Time `json:"created_at"`
    UpdatedAt        time.Time `json:"updated_at"`
}
```

- `AssignedToUserID` is a `*string` (nullable) — `nil` means unassigned.
- JSON serializes to `"assigned_to_user_id": null` or `"assigned_to_user_id": "abc..."`.

#### Enriched assignment info (response only)

To avoid N+1 queries on the client, the API should return basic assignee info alongside items. Two approaches:

**Option A — Inline on the item (recommended):**

```go
type NoteItem struct {
    // ... existing fields ...
    AssignedToUserID *string `json:"assigned_to_user_id"`
    AssignedUsername  string  `json:"assigned_username,omitempty"`
    AssignedFirstName string `json:"assigned_first_name,omitempty"`
    AssignedHasIcon   bool   `json:"assigned_has_profile_icon,omitempty"`
}
```

Populated via a LEFT JOIN when fetching items:

```sql
SELECT ni.id, ni.note_id, ni.text, ni.completed, ni.position,
       ni.indent_level, ni.assigned_to_user_id,
       u.username, u.first_name,
       u.profile_icon IS NOT NULL AS has_profile_icon,
       ni.created_at, ni.updated_at
FROM note_items ni
LEFT JOIN users u ON ni.assigned_to_user_id = u.id
WHERE ni.note_id = ?
ORDER BY ni.position;
```

**Go scanning note:** When `assigned_to_user_id` is NULL, the joined user columns are also NULL. Use `sql.NullString` / `sql.NullBool` for scanning, then map to the struct's string/bool fields (empty string and `false` for NULL rows). This matches how other nullable fields (e.g., `UnpinnedPosition`) are already handled in the codebase.

**Option B — Separate map on the note response:**

```go
type Note struct {
    // ... existing fields ...
    ItemAssignees map[string]AssigneeInfo `json:"item_assignees,omitempty"`
}
```

Option A is recommended because it keeps the data co-located with the item it belongs to, and the LEFT JOIN is efficient (indexed FK, bounded by the small number of items per note).

---

### 3. Handler / Request Types

#### `CreateNoteItem` and `UpdateNoteItem`

```go
type CreateNoteItem struct {
    Text             string  `json:"text"`
    Position         int     `json:"position"`
    IndentLevel      int     `json:"indent_level"`
    AssignedToUserID *string `json:"assigned_to_user_id,omitempty"`
}

type UpdateNoteItem struct {
    Text             string  `json:"text"`
    Position         int     `json:"position"`
    Completed        bool    `json:"completed"`
    IndentLevel      int     `json:"indent_level"`
    AssignedToUserID *string `json:"assigned_to_user_id,omitempty"`
}
```

#### Validation (in handler)

When `assigned_to_user_id` is non-nil:

1. Verify the user ID format is valid (`IsValidID`).
2. Verify the user exists.
3. Verify the user has access to the note (is owner or in `note_shares`).

If validation fails, return `400 Bad Request` with a descriptive message.

#### Store changes

**`CreateItem` and `CreateItemWithCompleted`:**

Add `assignedToUserID *string` parameter. The INSERT query adds the column:

```sql
INSERT INTO note_items (id, note_id, text, position, completed, indent_level, assigned_to_user_id)
VALUES (?, ?, ?, ?, ?, ?, ?);
```

**`getItemsByNoteID`:**

Extend the SELECT with a LEFT JOIN on `users` (as shown above) and scan the new fields.

**`UnshareNote` extension:**

```go
func (s *NoteStore) ClearAssignmentsForUser(noteID, userID string) error {
    _, err := s.db.Exec(
        `UPDATE note_items SET assigned_to_user_id = NULL
         WHERE note_id = ? AND assigned_to_user_id = ?`,
        noteID, userID,
    )
    return err
}
```

Called from `NotesHandler.UnshareNote` after successfully removing the share. For atomicity, consider wrapping `UnshareNote` and `ClearAssignmentsForUser` in a single database transaction so that if either operation fails, both are rolled back.

---

### 4. API Contract

No new endpoints. Assignments flow through the existing note create/update payloads.

#### Create note (POST `/api/v1/notes`)

Request body items gain an optional field:

```json
{
  "title": "Groceries",
  "note_type": "todo",
  "items": [
    { "text": "Milk", "position": 0, "indent_level": 0, "assigned_to_user_id": "abc123..." },
    { "text": "Eggs", "position": 1, "indent_level": 0 }
  ]
}
```

#### Update note (PUT `/api/v1/notes/{id}`)

Same pattern — items carry `assigned_to_user_id`.

#### Response payload

Items in the response include enriched assignee info:

```json
{
  "id": "noteXYZ",
  "items": [
    {
      "id": "item1",
      "text": "Milk",
      "completed": false,
      "position": 0,
      "indent_level": 0,
      "assigned_to_user_id": "user123",
      "assigned_username": "alice",
      "assigned_first_name": "Alice",
      "assigned_has_profile_icon": true,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### SSE

No new event types. The existing `note_updated` event carries the full note payload (including items with assignment data), which is sufficient for V1. If assignment changes become high-frequency, a dedicated `note_item_assigned` event could be added later.

---

### 5. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Assigned user is unshared from note | Assignments cleared (see `ClearAssignmentsForUser`); next `note_updated` SSE event reflects the change |
| Assigned user account is deleted | `ON DELETE SET NULL` clears the FK (requires `PRAGMA foreign_keys = ON`) |
| Item is completed | Assignment preserved (shows who completed it) |
| Item is uncompleted | Assignment preserved |
| Note is moved to trash | No change to assignments (they persist) |
| Note is restored from trash | Assignments still present |
| Assigning to a user without note access | `400 Bad Request` — rejected by validation |
| Self-assignment (owner assigns to self) | Allowed |
| Unshared note (no collaborators) | Assignment UI hidden; no one to assign to |
| Delete-and-recreate item update cycle | Assignment data in the update payload survives the cycle |
| Concurrent edits by two users | Last-write-wins (accepted limitation, consistent with current behavior) |
| `assigned_to_user_id` references a user not in `usersById` | Display fallback to `assigned_username` from API response, or "Unknown" if empty |

---

## Visual Design

### Design Principles

1. **Lightweight** — Jot is a note app, not Jira. Assignments should feel like a natural extension of the checklist, not a new paradigm.
2. **Consistent** — Reuse existing visual patterns: `LetterAvatar`, `ShareModal`-style user search, Tailwind utility classes.
3. **Progressive disclosure** — Don't clutter the UI for single-user notes or unshared notes. Show assignment controls only when there are collaborators.

---

### 3.1 Note Editor (`NoteModal` — `SortableItem`)

#### Current item layout

```
┌──────────────────────────────────────────────────────┐
│  ⠿  ☐  Item text here...                        🗑  │
│ drag    checkbox    text input                 delete │
└──────────────────────────────────────────────────────┘
```

#### Proposed layout (shared note, item unassigned)

The assign button appears only on hover, between the text and the delete button — matching the existing interaction density.

```
┌──────────────────────────────────────────────────────────┐
│  ⠿  ☐  Item text here...                   [+]      🗑  │
│ drag    checkbox    text input          assign(hover) del │
└──────────────────────────────────────────────────────────┘
```

- `[+]` is a 20×20 dashed-border circle (matching the label picker "+" button style).
- Appears on row hover only, to keep the default state clean.
- Not shown for completed items or single-user notes.

#### Proposed layout (shared note, item assigned)

When assigned, the avatar replaces the `[+]` button and is always visible:

```
┌──────────────────────────────────────────────────────────┐
│  ⠿  ☐  Item text here...                   (A)      🗑  │
│ drag    checkbox    text input           avatar      del  │
└──────────────────────────────────────────────────────────┘
```

- `(A)` is a 20×20 `LetterAvatar` (or profile image) of the assigned user.
- Hovering the avatar shows a tooltip with the full name.
- Clicking the avatar opens the assignee picker (to reassign or unassign).

#### Assignee Picker Popover

Clicking `[+]` or the avatar opens a small absolute-positioned popover below the button.

```
┌──────────────────────────────┐
│  ╳  Assign                   │
├──────────────────────────────┤
│  (A) Alice Williams          │  ← note owner
│  (B) Bob Martinez            │  ← shared user
│  (C) Carol Chen              │  ← shared user
├──────────────────────────────┤
│  ○  Unassign                 │  ← only if currently assigned
└──────────────────────────────┘
```

**Characteristics:**

- Fixed-width (~200px), max-height with scroll for many users.
- Lists all users with note access (owner + shared-with), each shown as avatar + display name.
- The currently assigned user (if any) has a subtle highlight or checkmark.
- An "Unassign" row at the bottom appears only when the item is currently assigned.
- Clicking a user assigns immediately (no confirmation needed) and closes the popover.
- Clicking outside or pressing Escape closes the popover.
- No search field needed for V1 (shared notes typically have <10 collaborators).

**Why not reuse `ShareModal`?** The share modal is a full dialog for searching all system users. The assignee picker is a lightweight popover limited to note collaborators. Different context, different pattern.

---

### 3.2 Card Preview (`NoteCard`)

On the dashboard card, show a tiny avatar next to each uncompleted item that has an assignment:

```
┌─────────────────────────┐
│  Groceries              │
│  ☐ Milk            (A)  │
│  ☐ Eggs                 │
│  ☐ Bread           (B)  │
│  +2 completed items     │
│                         │
│  (A)(B)                 │  ← existing share avatars
└─────────────────────────┘
```

- Avatar is 16×16 `LetterAvatar`, right-aligned in the item row.
- Unassigned items show no avatar (no empty placeholder).
- Read-only on the card — assignments are edited only in the modal.

---

### 3.3 States and Transitions

#### Unshared note (single user)

No assignment UI is shown. The item rows look exactly as they do today.

```
┌──────────────────────────────────────────────────────┐
│  ⠿  ☐  Item text here...                        🗑  │
└──────────────────────────────────────────────────────┘
```

**Why?** Assigning items to yourself on a non-shared note has no practical value. Hiding the UI keeps the experience clean.

#### Shared note, no items assigned

The `[+]` button appears on hover for uncompleted items:

```
Default state:
┌──────────────────────────────────────────────────────┐
│  ⠿  ☐  Buy groceries                            🗑  │
└──────────────────────────────────────────────────────┘

On hover:
┌──────────────────────────────────────────────────────────┐
│  ⠿  ☐  Buy groceries                       [+]      🗑  │
└──────────────────────────────────────────────────────────┘
```

#### Shared note, item assigned

Avatar always visible; hovering shows tooltip, clicking opens picker:

```
┌──────────────────────────────────────────────────────────┐
│  ⠿  ☐  Buy groceries                       (A)      🗑  │
└──────────────────────────────────────────────────────────┘
         tooltip on avatar hover: "Alice Williams"
```

#### Completed items

Completed items retain their assigned avatar (dimmed like the rest of the row) but the assignment is not editable:

```
┌──────────────────────────────────────────────────────────┐
│       ☑  Buy groceries  [strikethrough]     (A)          │
│       (dimmed, no drag, no delete, no assign change)     │
└──────────────────────────────────────────────────────────┘
```

---

### 3.4 Mobile / Narrow-Screen Considerations (Future)

The mobile item row is already dense: drag handle, checkbox, text input, and delete button fill the full width edge-to-edge (see reference screenshot below). The hover-based `[+]` pattern does not apply on touch devices.

**Reference — current mobile layout:**

```
┌──────────────────────────────────────┐
│  ⠿  ☐  Brot                     🗑  │   ← full-width, no room for hover targets
│  ⠿  ☐  und                      🗑  │
│  ⠿  ☐  was Anderes              🗑  │
│  + Element hinzufügen                │
│  [Besorgungen] [+]                   │
└──────────────────────────────────────┘
```

**Recommended mobile adaptations:**

- **Assigned items:** Always show a small (18px) avatar between the text and delete button. The text input shrinks slightly to accommodate it.
- **Unassigned items:** No visible assign button in the default state (keeps rows clean). Instead, use a **long-press context menu** on the item row with an "Assign" action, or place a small person-plus icon that is always visible but unobtrusive.
- **Assignee picker:** Use a **bottom sheet** (not a popover) listing collaborators, consistent with mobile OS conventions.
- **Alternative:** A swipe-to-reveal action (swipe left reveals "Assign" button) avoids adding any visible elements to the row.

These are out of scope for V1 but the API and data model are designed to support them without changes.

---

### 3.5 Dark Mode

All new elements follow the existing dark mode patterns:

| Element | Light | Dark |
|---------|-------|------|
| `[+]` circle border | `border-gray-300` | `border-slate-600` |
| `[+]` icon | `text-gray-400` | `text-gray-500` |
| Popover bg | `bg-white` | `bg-slate-800` |
| Popover border | `border-gray-200` | `border-slate-600` |
| Selected user bg | `bg-blue-50` | `bg-blue-900/20` |
| User name text | `text-gray-700` | `text-gray-200` |
| "Unassign" text | `text-red-600` | `text-red-400` |
| Tooltip bg | `bg-gray-900` | `bg-gray-700` |

---

## Accessibility

- **Assign button:** Has `aria-label="Assign item"` and is keyboard-focusable.
- **Assignee picker:** Arrow-key navigation (like `ShareModal`), Escape to close.
- **Avatar tooltip:** Uses `title` attribute (or `aria-label`) showing the assignee's full name.
- **Screen readers:** Assigned items read as "Item text, assigned to [Name]".

---

## Implementation Plan

### Phase 1 — Backend (estimated: ~2-3 hours)

1. Add migration `014_add_item_assignment.sql`.
2. Update `NoteItem` struct with assignment fields.
3. Update `getItemsByNoteID` query with LEFT JOIN.
4. Update `CreateItem`, `CreateItemWithCompleted` to accept and store `assignedToUserID`.
5. Add `ClearAssignmentsForUser` method.
6. Update `UnshareNote` handler to call `ClearAssignmentsForUser`.
7. Update `CreateNoteItem`/`UpdateNoteItem` request types in handlers.
8. Add assignment validation in `createTodoItems`/`updateTodoItems`.
9. Update Swagger annotations and regenerate docs.

### Phase 2 — Frontend (estimated: ~3-4 hours)

1. Update `NoteItem` TypeScript interface.
2. Update `CreateNoteRequest`/`UpdateNoteRequest` item types.
3. Build `AssigneePicker` component (popover with user list).
4. Update `SortableItem` in `NoteModal.tsx` to show assign button/avatar.
5. Update `NoteCard.tsx` to show avatars on assigned items.
6. Add i18n keys: `note.assignItem`, `note.unassign`, `note.assignedTo`, `note.noCollaborators`.
7. Pass collaborator list to `SortableItem`. Build the list from the note owner (`note.user_id` resolved via `usersById`) plus all entries in `note.shared_with`, producing an array of `{ userId, username, firstName, hasProfileIcon }`. This reuses the same `usersById` map already passed through for share avatars.

### Phase 3 — Tests (estimated: ~2-3 hours)

1. Server integration tests for assignment CRUD, validation, unshare cleanup.
2. Server unit test for `ClearAssignmentsForUser`.
3. Webapp component tests for `AssigneePicker`.
4. E2E Playwright test for the assign/unassign workflow.

### Phase 4 — Polish

1. Dark mode testing.
2. Accessibility audit.
3. Mobile-responsive check (modal on small screens).

---

## Future Extensions

- **Multiple assignees** — Replace `assigned_to_user_id` column with a `note_item_assignments` junction table.
- **"Assigned to me" filter** — Dashboard filter that queries `note_items.assigned_to_user_id = ?` across all accessible notes.
- **Assignment notifications** — SSE event `note_item_assigned` triggers a toast or badge for the assignee.
- **Due dates** — Add `due_date` column to `note_items`; combine with assignment for a lightweight task view.
- **Assignment in mobile app** — Bottom-sheet picker, consistent with the web popover.

---

## Open Questions

1. **Should completed items retain assignment?** (Proposed: yes — it serves as a record of who did what.)
2. **Should the assign button be visible on new (unsaved) notes?** (Proposed: no — the note must be saved and shared first, because item IDs and the collaborator list don't exist yet.)
3. **Maximum collaborators before the picker needs search?** (Proposed: add search if the list exceeds 8 users. For V1, no search is needed since shared notes rarely have many collaborators.)
