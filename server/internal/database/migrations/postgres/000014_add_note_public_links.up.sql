-- Public read-only links for notes (#1135).
--
-- At most one link per note, enforced by the named unique index on note_id
-- rather than by making note_id the primary key: allowing several links per
-- note later is then just dropping that index, whereas changing a primary key
-- in SQLite needs a full table rebuild.
--
-- The token is stored in plaintext, unlike session tokens (000006). There is
-- one link per note shared by the owner and every collaborator, so anyone with
-- access must be able to copy it again at any time; hashing would make it
-- show-once. The accepted trade-off is that a leaked database or backup yields
-- links that work until revoked. Do not switch to hashing without revisiting
-- multiple links per note.
--
-- Revoking deletes the row. created_by is kept (collaborators can create links
-- too) and set to NULL if that user is deleted. expires_at is compared against
-- the application clock; NULL means the link never expires.
CREATE TABLE note_public_links (
    id         TEXT     PRIMARY KEY,
    note_id    TEXT     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    token      TEXT     NOT NULL,
    created_by TEXT     REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

CREATE UNIQUE INDEX idx_note_public_links_note_id ON note_public_links(note_id);
CREATE UNIQUE INDEX idx_note_public_links_token   ON note_public_links(token);
