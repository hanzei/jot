# Group To-Do Items — Design

**Issue:** [#438 Group to-do items](https://github.com/hanzei/jot/issues/438)
**Date:** 2026-06-09
**Status:** Approved (brainstorm) — pending implementation plan

## Problem

Issue #438 raises three problems with list-note items today:

1. **Position restoration is unreliable.** Checked items store their original
   absolute position (`originalPosition` side-channel in `NoteModal.tsx`) and
   return there on uncheck. When items are added/removed before that position,
   the item lands somewhere unexpected.
2. **Indented items escape their category.** Checking/unchecking pulls an
   indented child out of its group into a flat global "Completed" pile, losing
   the context of which group it belonged to.
3. **No parent→child cascade (requested).** Checking a parent should check all
   its children; unchecking a parent should uncheck them.

The current model is flat: each item has `position` + `indent_level` (capped at
`MAX_INDENT = 1`, i.e. two levels). A "group" is only ever *inferred* from
indentation; there is no stored relationship.

## Decision summary

Adopt an **explicit grouping model** backed by a stored `parent_id` on items,
plus an **atomic cascade endpoint**. Breaking API changes are accepted for this
(coordinated webapp + mobile client updates; call out in the PR per CLAUDE.md).

| Concern | Decision |
| --- | --- |
| Grouping | Stored `parent_id` (nullable). Group = a parent (`parent_id IS NULL`) + its children. |
| Nesting depth | One level only (`MAX_INDENT = 1`). A child may not be a parent. |
| Completed UX | Completed children move to a global **Completed** section, grouped under a **ghost** copy of their parent. |
| Restore (#1) | Item retains its `position` in place; uncheck reappears at that position, clamped to the parent's current child block. |
| Drag (#2) | Free drag with **auto-reparent**: after a drop, `parent_id` is recomputed from the resulting position/indent. |
| Cascade (#3) | New atomic `toggle-completed` endpoint cascades parent→children in one transaction. |

## Data model

Add a nullable self-referencing `parent_id` to `note_items`:

```sql
-- migrations/{sqlite,postgres}/000002_add_parent_id_to_note_items.up.sql
ALTER TABLE note_items
  ADD COLUMN parent_id TEXT DEFAULT NULL
  REFERENCES note_items(id) ON DELETE SET NULL;

CREATE INDEX idx_note_items_parent_id ON note_items(parent_id);
```

**Backfill** (within the same migration): for every existing item with
`indent_level = 1`, set `parent_id` to the `id` of the nearest preceding item
(by `position`, same `note_id`) whose `indent_level = 0`. Any indent-1 item with
no preceding top-level item is treated as top-level (`parent_id` stays NULL).

`ON DELETE SET NULL` is deliberate — see *Orphans* below.

**`indent_level` becomes derived, read-only.** It is fully determined by
`parent_id` (`parent_id IS NULL ? 0 : 1`). The server computes and returns it for
client rendering convenience (clients already use it for `marginLeft`), but
**writes set `parent_id`, not `indent_level`**. We keep the column for now (the
server keeps it in sync) to minimize client-render churn; it may be dropped in a
later cleanup.

**Invariants (server-enforced on every write):**

- `parent_id`, when set, must reference an item in the **same note** whose own
  `parent_id IS NULL` (no grandchildren → enforces `MAX_INDENT = 1`).
- A parent's children occupy a **contiguous block** in `position` order
  immediately after the parent. The server normalizes positions on create /
  reorder / reparent to maintain this.

### Type changes (`shared/src/types.ts`)

- `NoteItem`: add `parent_id: string | null`. `indent_level` documented as
  server-derived/read-only.
- `CreateNoteItemRequest` / `PatchNoteItemRequest`: add `parent_id?: string | null`.
  Remove `indent_level` as a writable field (breaking).

## API changes

All breaking; enumerate in the PR with upgrade guidance.

1. **Item payloads carry `parent_id`** (read + write) instead of writable
   `indent_level`. Indent/un-indent (Tab / horizontal drag) now PATCHes
   `parent_id` rather than `indent_level`.

2. **New atomic cascade endpoint:**

   ```
   POST /notes/{noteId}/items/{itemId}/toggle-completed
   Body: { "completed": boolean }
   ```

   - Sets the target item's `completed`.
   - If the target is a **parent**, applies the same `completed` value to **all
     its children** in one transaction.
   - Direction is one-way only: checking the last open child does **not**
     auto-complete the parent (issue requests parent→child only).
   - Returns the affected items (or the updated note's items) so clients can
     reconcile in a single response.
   - Replaces the client-side fan-out of N per-item PATCHes — atomic, and
     replays as a single operation in the mobile offline queue.

   Toggling a **non-parent** item through this endpoint is allowed and simply
   toggles that one item (lets the client use one code path for all toggles).

3. Existing `POST /notes/{id}/items/reorder` (`item_ids`) stays for pure
   ordering. Structural moves that change grouping go through `parent_id` PATCH.

Regenerate Swagger (`task gen-docs`) after handler annotation changes.

## Behavior detail

### Completed section + ghost parents (render-time)

Items keep their stored `position` and `parent_id`; completed items are only
**filtered visually** into the Completed section — they do **not** lose their
data position.

Rendering the Completed section: for each completed child, look up its parent by
`parent_id` and render it beneath a **ghost** of that parent.

- **Ghost parent** = non-interactive label: a real-but-greyed empty checkbox and
  greyed parent text. Not checkable, editable, draggable, or assignable. No
  "group" tag. (See mockup `ghost-section-v2.html`.)
- If the parent is **itself completed** (cascade), it renders in the Completed
  section as the **real checked parent** with its real children beneath it — not
  a ghost.
- A **top-level completed item** (no `parent_id`, no children) moves down on its
  own with **no ghost**.
- A ghost disappears when its group's last completed child leaves the section.

Active items above render in full strength (`text-gray-900 dark:text-white`,
drag handles, blue checkboxes) per existing prod styling in
`SortableItem` (`NoteModal.tsx`).

### Restore — remembered relative spot (issue #1)

Because a completed item keeps its `position` in place, unchecking simply makes
it reappear in the active list at that position. If the group changed size while
the item was completed, clamp the restored position into the parent's **current
child block** (between the parent and the next top-level item). The buggy
`originalPosition` side-channel is **removed**.

### Drag — free / auto-reparent (issue #2)

Items may be dragged anywhere. After a drop, the item's `parent_id` is
recomputed from its resulting position and indent (auto-reparent). Group
membership therefore always matches the visual layout.

**Interpretation of issue #2 (confirm at review):** #2's concern — items
*spontaneously* escaping their category on check/uncheck — is fully resolved by
the group-aware Completed section + restore. A **deliberate manual drag** may
re-parent an item by design; the issue owner explicitly chose this freedom over
hard group-locked dragging.

### Cascade (issue #3)

Checking a parent checks all children; unchecking a parent unchecks all
children — atomically, via the `toggle-completed` endpoint. One-directional
(parent→child only).

## Edge cases (explicitly resolved, not deferred)

1. **Orphaned completed child** — parent deleted while the child sat in
   Completed. `ON DELETE SET NULL` promotes the child to top-level
   (`parent_id → NULL`); it then renders as a **top-level completed item with no
   ghost**. No data loss, no dangling reference. (Deleting a parent therefore
   *promotes* its children to standalone tasks rather than deleting them.)

2. **Clamping on restore** — group shrank/grew during completion. Restore clamps
   the item's stored position into the parent's current child-block bounds (end
   of the block if out of range).

3. **Cascade mechanics** — server-side, single transaction (above). No
   client-side partial-failure handling; the endpoint either fully applies or
   fails. Mobile offline queue stores it as one replayable operation.

## Scope & components

- **Server:** migration `000002` (sqlite + postgres, up/down); `NoteItemStore`
  changes (parent_id read/write, invariant enforcement, position normalization);
  new `toggle-completed` handler + route; validation; Swagger regen.
- **shared:** `types.ts` updates above.
- **webapp (primary):** `NoteModal.tsx` (ghost rendering, restore logic removal,
  auto-reparent on drag/indent, switch toggles to the new endpoint);
  `NoteCard.tsx` preview (ghost rendering in the read-only card).
- **mobile:** API client + offline-sync updates to consume `parent_id` and the
  `toggle-completed` endpoint; ghost rendering in list components. (Detailed in
  the implementation plan; webapp-first.)

## Testing

- **Server:** store-level tests for parent_id invariants (reject grandchild,
  cross-note parent), backfill correctness, cascade atomicity, orphan
  promotion on parent delete. New integration test file for the
  `toggle-completed` endpoint alongside existing `http_task_assignment_test.go`.
- **webapp:** unit tests for ghost grouping, restore clamping, auto-reparent on
  drag/indent (`NoteModal.test.tsx`).
- **e2e:** new Playwright spec — create a group, check parent (cascade),
  uncheck a child (restore into group), drag to reparent, delete a parent
  (children promoted).
- **mobile:** Jest tests for offline replay of `toggle-completed`.

## Out of scope

- Nesting deeper than one level (`MAX_INDENT` stays 1).
- Children→parent auto-completion (only parent→child cascade requested).
- Dropping the `indent_level` column (kept as derived; possible later cleanup).
