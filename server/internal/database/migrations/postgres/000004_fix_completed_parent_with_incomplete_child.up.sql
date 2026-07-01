-- Backfill for the checklist invariant now enforced by ToggleItemCompleted and
-- PatchItem: a top-level (parent) item can never be completed while one of
-- its children is not. Before this was enforced, unchecking a single child
-- left its already-completed parent stuck at completed = true (the parent
-- only ever cascaded down to children, never back up), producing exactly that
-- inconsistent state. Un-complete any parent that currently has an incomplete
-- child so existing data matches the new invariant going forward.
UPDATE note_items
SET completed = FALSE, updated_at = CURRENT_TIMESTAMP
WHERE parent_id IS NULL
  AND completed = TRUE
  AND id IN (
      SELECT DISTINCT parent_id
      FROM note_items
      WHERE parent_id IS NOT NULL
        AND completed = FALSE
  );
