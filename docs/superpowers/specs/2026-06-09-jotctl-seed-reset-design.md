# Design: `jotctl seed` and `jotctl reset`

**Date:** 2026-06-09  
**Status:** Approved

## Problem

Manual testing requires a populated server environment — users, notes in various states, labels, sharing relationships. Setting this up by hand after each reset is slow. The tools must work over HTTP so they can target remote servers without SSH access.

## Solution

Two new subcommands added to `jotctl`:

- `jotctl seed` — adds scenario-rich test data to the server (additive, no prompt)
- `jotctl reset` — wipes all non-admin users and their data, then reseeds (destructive, requires confirmation)

Both require an active `jotctl login` session with admin role.

---

## Commands

### `jotctl seed`

Runs immediately with no confirmation prompt (additive — safe to run multiple times).

```
jotctl seed
```

Logs each step to stdout:

```
Seeding test data on http://localhost:8080...
  ✓ Created user alice
  ✓ Created user bob
  ✓ Created user carol
  ✓ Uploaded profile icon for alice
  ✓ Updated settings for alice (theme: dark, sort: manual, lang: en)
  ✓ Updated settings for bob (theme: light, sort: updated_at, lang: de)
  ✓ Updated settings for carol (theme: system, sort: created_at, lang: fr)
  ✓ Created 13 notes for alice
  ✓ Applied labels: work, personal, ideas, urgent
  ✓ Shared 3 notes with bob
  ✓ Created 3 notes for bob
  ✓ Created 3 notes for carol
Done. 3 users, 19 notes, 4 labels created.
```

### `jotctl reset`

Prompts before wiping. Accepts `--yes` to skip for scripting.

```
jotctl reset
jotctl reset --yes
```

Confirmation prompt:

```
This will DELETE all non-admin users and their data on http://localhost:8080. Continue? [y/N]:
```

Reset flow:
1. List all users via `AdminListUsers`
2. Skip the currently authenticated admin user
3. Delete each remaining user (server cascades deletion to their notes, labels, sessions)
4. Call seed internally

---

## Seed Dataset

All seed users have password `test`.

### Users

| Username | Theme | NoteSort | Language | Profile Icon | Display Name |
|---|---|---|---|---|---|
| `alice` | `dark` | `manual` | `en` | yes | Alice |
| `bob` | `light` | `updated_at` | `de` | no | Bob Smith |
| `carol` | `system` | `created_at` | `fr` | no | Carol |

Every valid theme (`system`, `light`, `dark`) and every valid NoteSort (`manual`, `updated_at`, `created_at`) is represented. Three languages cover a spread of the 8 supported locales.

### Alice's Notes

**Active text notes (4):**
- Rich markdown: headings, bold, inline code, fenced code block, links
- Pinned plain note
- Colored note (non-default color)
- Plain text note

**Active list notes (3):**
- Mix of checked and unchecked items
- `checked_items_collapsed: true` on one
- One with a label applied

**Archived notes (3):**
- 2 text, 1 list

**Trashed notes (3):**
- Mix of text and list

**Shared with Bob (3):**
- Three of Alice's active notes shared with Bob

**Labels applied to Alice's notes:** `work`, `personal`, `ideas`, `urgent` — distributed across active notes so label filter shows varied results.

### Bob's Notes

3 plain text notes, label `work` on one. Bob can see Alice's shared notes in his view.

### Carol's Notes

3 plain text notes. Carol exists primarily for settings coverage; her content is minimal.

---

## Implementation

### New Files

**`server/cmd/jotctl/cmd/seed.go`**  
Command definitions and execution logic for `seed` and `reset`. Iterates the dataset from `seeddata.go`, calls the Go client SDK for each operation, logs progress.

Note: notes and labels must be created while authenticated as the owning user, not as the admin. After creating each user via the admin API, seed creates a temporary `client.Client` instance and calls `Login` with that user's credentials to obtain a session, then uses that session for note/label/settings operations on their behalf.

**`server/cmd/jotctl/cmd/seeddata.go`**  
Hardcoded dataset as Go structs (`seedUser`, `seedNote`). No HTTP logic — pure data. Easy to extend without touching command flow.

### Profile Icon

The seed command embeds `webapp/e2e/fixtures/test-icon.png` via `//go:embed`. No external file dependency at runtime — the icon is baked into the binary.

### How `reset` Identifies the Admin User to Skip

After `AdminListUsers`, the command compares each user against the currently authenticated session (loaded from the session file) by calling `Me()` once at the start of reset, then filters that user ID out of the deletion list.

### Error Handling

- If a user already exists with the seed username, log a warning and skip (don't abort the whole run).
- Other errors abort with a descriptive message.
- `reset` aborts before deleting anything if the user list fetch fails.

### `--json` Flag

`seed` and `reset` respect the existing global `--json` flag. In JSON mode, suppress the progress lines and emit a single summary object at the end:

```json
{"users_created": 3, "notes_created": 19, "labels_created": 4}
```

---

## Files to Create / Modify

| File | Change |
|---|---|
| `server/cmd/jotctl/cmd/seed.go` | New — seed and reset command definitions |
| `server/cmd/jotctl/cmd/seeddata.go` | New — hardcoded dataset structs |
| `server/cmd/jotctl/cmd/root.go` | Add `seedCmd` and `resetCmd` to `rootCmd` |
