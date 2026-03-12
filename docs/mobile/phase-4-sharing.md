# Phase 4 — Sharing

## Goal

Implement note sharing: searching for users, sharing/unsharing notes, displaying share indicators on cards, and the share sheet screen. At the end of this phase users can collaborate on notes with other Jot users.

---

## Prerequisites

- Phase 3 complete (context menu, note editor toolbar)

---

## What to Build

### 1. New Files

```
mobile/src/
├── screens/
│   └── ShareScreen.tsx
├── components/
│   └── UserAvatar.tsx
└── api/
    └── users.ts
```

### 2. API Functions (`src/api/users.ts`)

| Function | Endpoint | Notes |
|----------|----------|-------|
| `searchUsers(query)` | `GET /api/v1/users?search=...` | Returns matching users (excludes self) |
| `shareNote(noteId, userId)` | `POST /api/v1/notes/{id}/share` | Body: `{ user_id }` |
| `unshareNote(noteId, userId)` | `DELETE /api/v1/notes/{id}/share` | Body: `{ user_id }` |
| `getNoteShares(noteId)` | `GET /api/v1/notes/{id}/shares` | List current shares |

### 3. Share Screen

Opened from the note editor toolbar "Share" button or the context menu "Share" action. Presented as a modal.

**Layout:**
- Search field at the top for username lookup
- As the user types, results appear below (debounced 300ms)
- Each result row shows: `UserAvatar`, display name (first + last), username
- Tapping a user shares the note with them → row moves to the "Shared with" section below
- **Shared with** section: lists current shares, each with a remove button
- Tapping remove calls `DELETE /api/v1/notes/{id}/share` and removes the row

**Behavior:**
- Only the note owner can access the share screen (the server enforces this, but hide the share button for shared-with-me notes on the client too)
- After sharing/unsharing, invalidate the note query to refresh `shared_with` data

### 4. UserAvatar Component

Displays a user's profile icon or falls back to a letter avatar:
- If `has_profile_icon` is true, load from `GET /api/v1/users/{id}/profile-icon`
- Otherwise, render a colored circle with the first letter of the username
- Consistent color derived from the username string (simple hash → palette index)
- Size prop for different contexts (small for note cards, medium for share sheet)

### 5. Share Indicators on NoteCard

Update the `NoteCard` component from Phase 2:
- If `note.shared_with` is non-empty, show a row of small `UserAvatar` components (max 3, then "+N" overflow)
- If the note is shared with the current user (i.e., `note.is_shared` is true and the user is not the owner), show a subtle "Shared with you" label or a share icon

### 6. Context Menu Update

Add a **Share** action to the notes list context menu (Phase 3). Tapping it navigates to the Share Screen for that note.

### 7. Note Editor Toolbar Update

Add a **Share** button to the note editor toolbar. Tapping it opens the Share Screen as a modal.

---

## Server Endpoints Consumed

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/users?search=...` | Search users by username |
| POST | `/api/v1/notes/{id}/share` | Share note with a user |
| DELETE | `/api/v1/notes/{id}/share` | Revoke share |
| GET | `/api/v1/notes/{id}/shares` | List users note is shared with |
| GET | `/api/v1/users/{id}/profile-icon` | Fetch user profile image |

---

## Acceptance Criteria

- [ ] Share button appears in the note editor toolbar and context menu (owner only)
- [ ] Share screen opens as a modal
- [ ] User search returns matching users as the user types
- [ ] Tapping a search result shares the note and moves the user to the "Shared with" list
- [ ] Remove button unshares the note
- [ ] Note cards show share avatars when shared with others
- [ ] Shared-with-me notes show a "Shared with you" indicator
- [ ] UserAvatar displays profile icon or letter fallback
- [ ] Share actions are hidden for notes the user does not own
