CREATE VIEW active_notes AS
    SELECT * FROM notes WHERE deleted_at IS NULL;
