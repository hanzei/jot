-- Add the folded label-name key. See the SQLite migration of the same number
-- for the full rationale; the two are identical in intent and nearly identical
-- in SQL.
--
-- Label names are unique per user without regard to case, and until now that
-- rule was enforced by SQL: PostgreSQL's `UNIQUE (user_id, LOWER(name COLLATE
-- "C"))` from 000009, pinned to the ASCII-only fold SQLite's COLLATE NOCASE
-- performs. "Äpfel" and "äpfel" were therefore two labels where the user meant
-- one -- see https://github.com/hanzei/jot/issues/773.
--
-- The rule now lives in Go (internal/labelfold.Fold) and each row stores its
-- folded key here. PostgreSQL's own LOWER() is not used to populate it: it is
-- locale-dependent, and it lower-cases rather than case-folds, so it disagrees
-- with Go on 'ß' and on Greek final sigma. A value that disagrees with Go is
-- worse than no value -- the row would be permanently invisible to the
-- de-duplication it exists to serve -- so the column is populated in Go
-- instead, together with the duplicate merge and the unique index, right after
-- migrations run (backfillLabelNameFolded in internal/database).
ALTER TABLE labels ADD COLUMN name_folded TEXT NOT NULL DEFAULT '';

-- The old ASCII-only index is superseded by UNIQUE (user_id, name_folded),
-- which the Go backfill creates once every row has a folded key. Dropping it
-- here rather than there keeps schema changes in the migration tree wherever
-- they can be expressed in SQL.
DROP INDEX IF EXISTS idx_labels_user_id_lower_name;
