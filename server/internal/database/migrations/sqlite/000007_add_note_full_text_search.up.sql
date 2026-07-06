-- Full-text note search backed by an FTS5 index, replacing the previous
-- leading-wildcard LIKE scan (no index could serve it) with a real inverted
-- index over each note's title, content, and list-item text.
--
-- Design: one FTS row per note whose "body" aggregates the note title, the note
-- content, and every list item's text. Aggregating into a single row (rather
-- than one row per source field) lets a multi-word query match when its terms
-- are spread across the title and an item — e.g. "weekend groceries" where
-- "weekend" is the title and "groceries" is a checklist item. The note_id is
-- carried as an UNINDEXED column so the index can be maintained (targeted
-- UPDATE/DELETE) and joined back to notes by note_id, avoiding any reliance on
-- SQLite's implicit rowid (which VACUUM may renumber).
--
-- Tokenizer: unicode61 with remove_diacritics disabled, so matching is
-- case-insensitive (including non-ASCII, e.g. CAFÉ = café) but diacritic
-- sensitive. This mirrors the Postgres 'simple' text-search configuration so
-- results are consistent across DB_DRIVER.
CREATE VIRTUAL TABLE note_search USING fts5(
    note_id UNINDEXED,
    body,
    tokenize = 'unicode61 remove_diacritics 0'
);

-- Backfill the index for existing installations. group_concat concatenates all
-- of a note's item texts; COALESCE handles notes with no items.
INSERT INTO note_search(note_id, body)
SELECT n.id,
       n.title || ' ' || n.content || ' ' ||
       COALESCE((SELECT group_concat(ni.text, ' ') FROM note_items ni WHERE ni.note_id = n.id), '')
FROM notes n;

-- Keep the index in sync through every note/item write path (create, edit,
-- convert, import, duplicate, trash, restore, purge) via triggers, so no Go
-- code path can forget to update it.

CREATE TRIGGER note_search_notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO note_search(note_id, body)
    VALUES (
        new.id,
        new.title || ' ' || new.content || ' ' ||
        COALESCE((SELECT group_concat(ni.text, ' ') FROM note_items ni WHERE ni.note_id = new.id), '')
    );
END;

CREATE TRIGGER note_search_notes_au AFTER UPDATE ON notes BEGIN
    UPDATE note_search
       SET body = new.title || ' ' || new.content || ' ' ||
                  COALESCE((SELECT group_concat(ni.text, ' ') FROM note_items ni WHERE ni.note_id = new.id), '')
     WHERE note_id = new.id;
END;

CREATE TRIGGER note_search_notes_ad AFTER DELETE ON notes BEGIN
    DELETE FROM note_search WHERE note_id = old.id;
END;

-- Item triggers rebuild the owning note's aggregated body. They read the note's
-- title/content via subquery since NEW/OLD here are note_items rows.

CREATE TRIGGER note_search_items_ai AFTER INSERT ON note_items BEGIN
    UPDATE note_search
       SET body = (SELECT n.title || ' ' || n.content FROM notes n WHERE n.id = new.note_id) || ' ' ||
                  COALESCE((SELECT group_concat(ni.text, ' ') FROM note_items ni WHERE ni.note_id = new.note_id), '')
     WHERE note_id = new.note_id;
END;

CREATE TRIGGER note_search_items_au AFTER UPDATE ON note_items BEGIN
    UPDATE note_search
       SET body = (SELECT n.title || ' ' || n.content FROM notes n WHERE n.id = new.note_id) || ' ' ||
                  COALESCE((SELECT group_concat(ni.text, ' ') FROM note_items ni WHERE ni.note_id = new.note_id), '')
     WHERE note_id = new.note_id;
END;

CREATE TRIGGER note_search_items_ad AFTER DELETE ON note_items BEGIN
    UPDATE note_search
       SET body = (SELECT n.title || ' ' || n.content FROM notes n WHERE n.id = old.note_id) || ' ' ||
                  COALESCE((SELECT group_concat(ni.text, ' ') FROM note_items ni WHERE ni.note_id = old.note_id), '')
     WHERE note_id = old.note_id;
END;
