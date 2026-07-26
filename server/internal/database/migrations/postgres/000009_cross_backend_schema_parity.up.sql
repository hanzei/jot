-- Bring existing PostgreSQL installations in line with the SQLite schema.
-- New installations get the same result straight from 000001, so every
-- statement here is written to be a no-op when it has nothing to do.

-- 1. Drop the note_type CHECK constraint. SQLite never had it, so the two
--    backends enforced different invariants; allowed values are validated in
--    the application layer instead.
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_note_type_check;

-- 2. Enforce case-insensitive uniqueness of label names per user, matching
--    SQLite's COLLATE NOCASE column. Existing rows may already violate it
--    ("Work" and "work" for the same user), so merge those first: keep the
--    oldest label of each case-insensitive name and repoint its duplicates'
--    note associations at it.
CREATE TEMP TABLE label_dedup_map AS
SELECT l.id AS dup_id,
       l.user_id,
       (SELECT k.id
          FROM labels k
         WHERE k.user_id = l.user_id
           AND LOWER(k.name) = LOWER(l.name)
         ORDER BY k.created_at, k.id
         LIMIT 1) AS keep_id
  FROM labels l;

DELETE FROM label_dedup_map WHERE dup_id = keep_id;

-- Drop associations that would collide with one the surviving label already
-- has, since note_labels is UNIQUE(note_id, label_id, user_id).
DELETE FROM note_labels nl
 USING label_dedup_map m
 WHERE nl.label_id = m.dup_id
   AND nl.user_id = m.user_id
   AND EXISTS (SELECT 1
                 FROM note_labels s
                WHERE s.note_id = nl.note_id
                  AND s.user_id = nl.user_id
                  AND s.label_id = m.keep_id);

UPDATE note_labels nl
   SET label_id = m.keep_id
  FROM label_dedup_map m
 WHERE nl.label_id = m.dup_id
   AND nl.user_id = m.user_id;

DELETE FROM labels l
 USING label_dedup_map m
 WHERE l.id = m.dup_id;

DROP TABLE label_dedup_map;

-- The case-sensitive constraint is subsumed by the case-insensitive index, and
-- ON CONFLICT (user_id, LOWER(name)) needs the latter to infer against.
-- Note LOWER() is locale-aware on PostgreSQL but ASCII-only on SQLite, so
-- names differing only in non-ASCII case still collide on PostgreSQL alone.
ALTER TABLE labels DROP CONSTRAINT IF EXISTS labels_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_user_id_lower_name ON labels (user_id, LOWER(name));
