-- Backfill for the ordering invariant now enforced by normalizeItemOrderTx
-- (internal/models/note_store_items.go): along a note's display order, where
-- each top-level item is immediately followed by its children, positions
-- strictly increase. Before it was enforced, a re-parent kept the item's old
-- position and a reorder stored whatever order a client sent, so a
-- drag-to-reparent whose follow-up reorder never landed, or a reorder from a
-- device that had not yet seen a re-parent, left a child ordered before its
-- parent. The editors regroup on load, but the note cards, mobile's local
-- store, and the export read items by position and showed or wrote them out of
-- order.
--
-- Only notes that violate the invariant are touched; within those, every item
-- is re-sequenced to 0..N-1 in display order, exactly as the store does. The
-- sort key below must stay in step with groupedItemOrder: items read in
-- (position, created_at, id) order, and a child whose parent is not a
-- top-level item of the same note keeps its own place.

CREATE TEMP TABLE note_item_order_fix AS
WITH keyed AS (
    SELECT c.id,
           c.note_id,
           c.position,
           c.created_at,
           COALESCE(p.position, c.position)     AS group_position,
           COALESCE(p.created_at, c.created_at) AS group_created_at,
           COALESCE(p.id, c.id)                 AS group_id,
           CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS is_child
    FROM note_items c
    LEFT JOIN note_items p
      ON p.id = c.parent_id
     AND p.note_id = c.note_id
     AND p.parent_id IS NULL
),
ranked AS (
    SELECT id,
           note_id,
           position,
           ROW_NUMBER() OVER display_order - 1 AS new_position,
           LAG(position) OVER display_order    AS previous_position
    FROM keyed
    WINDOW display_order AS (
        PARTITION BY note_id
        ORDER BY group_position, group_created_at, group_id, is_child, position, created_at, id
    )
)
SELECT id, note_id, position, new_position
FROM ranked
WHERE note_id IN (SELECT note_id FROM ranked WHERE previous_position >= position);

-- Bump the repaired notes' updated_at so timestamp-based sync/cache logic
-- (which normally sees every note_items change via touchNoteTx) picks up the
-- new order instead of keeping a stale cached copy.
UPDATE notes
SET updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT DISTINCT note_id FROM note_item_order_fix);

UPDATE note_items
SET position = (SELECT f.new_position FROM note_item_order_fix f WHERE f.id = note_items.id),
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM note_item_order_fix WHERE new_position <> position);

DROP TABLE note_item_order_fix;
