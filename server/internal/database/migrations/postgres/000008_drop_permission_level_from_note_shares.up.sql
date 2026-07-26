-- Drop permission_level from note_shares: the column's CHECK constraint only
-- ever allowed 'edit', so it was a single-value field masquerading as an open
-- string in every client-facing type. Dropping it now (pre-v1) keeps the
-- field additive when read-only / multi-level sharing is actually built.
ALTER TABLE note_shares DROP COLUMN permission_level;
