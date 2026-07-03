-- Note images table: metadata for images attached to a note. Bytes live on
-- disk in the Blobstore, content-addressed by sha256; this row is the
-- pointer plus display metadata. Removal is a plain hard-delete (undo is
-- entirely client-side, deferred until the client's own toast expires), so
-- there is no soft-delete column here; blob GC runs at delete time plus a
-- periodic orphan sweep.
CREATE TABLE note_images (
    id           TEXT      PRIMARY KEY,
    note_id      TEXT      NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    uploader_id  TEXT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename     TEXT      NOT NULL,
    content_type TEXT      NOT NULL,
    size_bytes   BIGINT    NOT NULL,
    sha256       TEXT      NOT NULL,
    width        INTEGER   NOT NULL,
    height       INTEGER   NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_note_images_note_id ON note_images(note_id, created_at);
CREATE INDEX idx_note_images_sha256  ON note_images(sha256);
