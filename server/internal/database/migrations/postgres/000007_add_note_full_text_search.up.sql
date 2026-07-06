-- Full-text note search backed by a tsvector index, replacing the previous
-- LIKE scan (which was additionally case-sensitive on Postgres). Mirrors the
-- SQLite FTS5 shape: one search row per note whose tsvector aggregates the note
-- title, content, and every list item's text, so a multi-word query matches
-- when its terms are spread across the title and an item.
--
-- A side table (rather than a generated tsvector column on notes) is required
-- because the aggregate spans rows in two tables (notes + note_items), which a
-- generated column cannot express. Using the 'simple' text-search configuration
-- keeps tokenization language-neutral, case-insensitive, and diacritic
-- sensitive, matching SQLite's 'unicode61 remove_diacritics 0' so results are
-- consistent across DB_DRIVER.
CREATE TABLE note_search (
    note_id    TEXT     NOT NULL PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    search_tsv TSVECTOR NOT NULL
);

CREATE INDEX idx_note_search_tsv ON note_search USING GIN (search_tsv);

-- note_search_refresh recomputes and upserts a single note's aggregated
-- tsvector. It is a no-op when the note no longer exists (e.g. invoked from an
-- item trigger while the owning note is being cascade-deleted), so it never
-- resurrects a row the cascade just removed.
CREATE FUNCTION note_search_refresh(p_note_id TEXT) RETURNS void LANGUAGE sql AS $$
    INSERT INTO note_search (note_id, search_tsv)
    SELECT n.id,
           to_tsvector('simple',
               coalesce(n.title, '') || ' ' || coalesce(n.content, '') || ' ' ||
               coalesce((SELECT string_agg(ni.text, ' ') FROM note_items ni WHERE ni.note_id = n.id), ''))
    FROM notes n
    WHERE n.id = p_note_id
    ON CONFLICT (note_id) DO UPDATE SET search_tsv = EXCLUDED.search_tsv;
$$;

CREATE FUNCTION note_search_notes_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM note_search_refresh(NEW.id);
    RETURN NULL;
END;
$$;

CREATE FUNCTION note_search_items_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM note_search_refresh(OLD.note_id);
    ELSE
        PERFORM note_search_refresh(NEW.note_id);
    END IF;
    RETURN NULL;
END;
$$;

-- Keep the index in sync through every note/item write path. A note's own row
-- is removed by the ON DELETE CASCADE above, so no notes DELETE trigger is
-- needed.
CREATE TRIGGER note_search_notes_aiu
    AFTER INSERT OR UPDATE ON notes
    FOR EACH ROW EXECUTE FUNCTION note_search_notes_trigger();

CREATE TRIGGER note_search_items_aiud
    AFTER INSERT OR UPDATE OR DELETE ON note_items
    FOR EACH ROW EXECUTE FUNCTION note_search_items_trigger();

-- Backfill the index for existing installations.
INSERT INTO note_search (note_id, search_tsv)
SELECT n.id,
       to_tsvector('simple',
           coalesce(n.title, '') || ' ' || coalesce(n.content, '') || ' ' ||
           coalesce((SELECT string_agg(ni.text, ' ') FROM note_items ni WHERE ni.note_id = n.id), ''))
FROM notes n;
