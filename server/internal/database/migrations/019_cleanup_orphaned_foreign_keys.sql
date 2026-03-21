-- Remove rows that violate declared foreign keys before runtime enforcement
-- becomes mandatory on every SQLite connection.

DELETE FROM note_items
WHERE NOT EXISTS (
  SELECT 1
  FROM notes
  WHERE notes.id = note_items.note_id
);

DELETE FROM note_labels
WHERE NOT EXISTS (
  SELECT 1
  FROM notes
  WHERE notes.id = note_labels.note_id
);

DELETE FROM note_labels
WHERE NOT EXISTS (
  SELECT 1
  FROM labels
  WHERE labels.id = note_labels.label_id
);

DELETE FROM note_shares
WHERE NOT EXISTS (
  SELECT 1
  FROM notes
  WHERE notes.id = note_shares.note_id
);

DELETE FROM note_shares
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = note_shares.shared_with_user_id
);

DELETE FROM note_shares
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = note_shares.shared_by_user_id
);

DELETE FROM sessions
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = sessions.user_id
);

DELETE FROM user_settings
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = user_settings.user_id
);

DELETE FROM labels
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = labels.user_id
);

DELETE FROM notes
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = notes.user_id
);
