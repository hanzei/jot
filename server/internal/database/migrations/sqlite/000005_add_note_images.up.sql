-- Note images table: metadata for images attached to a note. Bytes live on
-- disk in the Blobstore, content-addressed by sha256; this row is the
-- pointer plus display metadata. deleted_at is a soft-delete for the undo
-- window; hard-deletion (and blob reclaim) is handled by a later sweep.
CREATE TABLE note_images (
    id           TEXT     PRIMARY KEY,
    note_id      TEXT     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    uploader_id  TEXT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename     TEXT     NOT NULL,
    content_type TEXT     NOT NULL,
    size_bytes   INTEGER  NOT NULL,
    sha256       TEXT     NOT NULL,
    width        INTEGER  NOT NULL,
    height       INTEGER  NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   DATETIME DEFAULT NULL
);

CREATE INDEX idx_note_images_note_id ON note_images(note_id, created_at);
CREATE INDEX idx_note_images_sha256  ON note_images(sha256);
