package models

import (
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testSchema = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL DEFAULT 'user',
	first_name TEXT NOT NULL DEFAULT '',
	last_name TEXT NOT NULL DEFAULT '',
	profile_icon BLOB,
	profile_icon_content_type TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	title TEXT NOT NULL DEFAULT '',
	content TEXT NOT NULL DEFAULT '',
	note_type TEXT NOT NULL DEFAULT 'text',
	color TEXT NOT NULL DEFAULT '#ffffff',
	pinned BOOLEAN NOT NULL DEFAULT FALSE,
	archived BOOLEAN NOT NULL DEFAULT FALSE,
	position INTEGER NOT NULL DEFAULT 0,
	unpinned_position INTEGER,
	checked_items_collapsed BOOLEAN NOT NULL DEFAULT FALSE,
	deleted_at DATETIME,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE note_items (
	id TEXT PRIMARY KEY,
	note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	text TEXT NOT NULL DEFAULT '',
	completed BOOLEAN NOT NULL DEFAULT FALSE,
	position INTEGER NOT NULL DEFAULT 0,
	indent_level INTEGER NOT NULL DEFAULT 0,
	assigned_to TEXT NOT NULL DEFAULT '',
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE note_shares (
	id TEXT PRIMARY KEY,
	note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
	shared_with_user_id TEXT NOT NULL REFERENCES users(id),
	shared_by_user_id TEXT NOT NULL REFERENCES users(id),
	permission_level TEXT NOT NULL DEFAULT 'edit',
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(note_id, shared_with_user_id)
);

CREATE INDEX idx_note_items_note_id ON note_items(note_id);
CREATE INDEX idx_note_items_assigned_to ON note_items(assigned_to);
CREATE INDEX idx_note_items_note_assigned ON note_items(note_id, assigned_to);
`

func setupTestDB(t *testing.T) *sql.DB {
	t.Helper()
	tmpFile := t.TempDir() + "/test.db"
	db, err := sql.Open("sqlite3", tmpFile)
	require.NoError(t, err)
	_, err = db.Exec(testSchema)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func insertUser(t *testing.T, db *sql.DB, id, username string) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO users (id, username) VALUES (?, ?)`, id, username)
	require.NoError(t, err)
}

func insertNote(t *testing.T, db *sql.DB, id, userID string) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO notes (id, user_id, note_type) VALUES (?, ?, 'todo')`, id, userID)
	require.NoError(t, err)
}

func insertItem(t *testing.T, db *sql.DB, id, noteID, text string, position int, assignedTo string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO note_items (id, note_id, text, position, assigned_to) VALUES (?, ?, ?, ?, ?)`,
		id, noteID, text, position, assignedTo,
	)
	require.NoError(t, err)
}

func insertShare(t *testing.T, db *sql.DB, id, noteID, sharedWithID, sharedByID string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id) VALUES (?, ?, ?, ?)`,
		id, noteID, sharedWithID, sharedByID,
	)
	require.NoError(t, err)
}

func getAssignment(t *testing.T, db *sql.DB, itemID string) string {
	t.Helper()
	var assignedTo string
	err := db.QueryRow(`SELECT assigned_to FROM note_items WHERE id = ?`, itemID).Scan(&assignedTo)
	require.NoError(t, err)
	return assignedTo
}

func TestClearUserAssignmentsTx(t *testing.T) {
	t.Run("clears assignments for deleted user", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertUser(t, db, "collab2", "collab2")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertShare(t, db, "share2", "note1", "collab2", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "collab1")
		insertItem(t, db, "item2", "note1", "Task B", 1, "collab2")

		tx, err := db.Begin()
		require.NoError(t, err)
		require.NoError(t, store.ClearUserAssignmentsTx(tx, "collab1"))
		require.NoError(t, tx.Commit())

		assert.Empty(t, getAssignment(t, db, "item1"), "deleted user's assignment should be cleared")
		assert.Equal(t, "collab2", getAssignment(t, db, "item2"), "other user's assignment should remain")
	})

	t.Run("removes shares for deleted user", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")

		tx, err := db.Begin()
		require.NoError(t, err)
		require.NoError(t, store.ClearUserAssignmentsTx(tx, "collab1"))
		require.NoError(t, tx.Commit())

		var shareCount int
		require.NoError(t, db.QueryRow(`SELECT COUNT(*) FROM note_shares WHERE shared_with_user_id = ?`, "collab1").Scan(&shareCount))
		assert.Equal(t, 0, shareCount, "shares for deleted user should be removed")
	})

	t.Run("clears all assignments when note becomes unshared", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "owner1")
		insertItem(t, db, "item2", "note1", "Task B", 1, "collab1")

		tx, err := db.Begin()
		require.NoError(t, err)
		require.NoError(t, store.ClearUserAssignmentsTx(tx, "collab1"))
		require.NoError(t, tx.Commit())

		assert.Empty(t, getAssignment(t, db, "item1"), "owner self-assignment should be cleared when note becomes unshared")
		assert.Empty(t, getAssignment(t, db, "item2"), "deleted user's assignment should be cleared")
	})

	t.Run("preserves assignments on notes that still have shares", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertUser(t, db, "collab2", "collab2")
		insertNote(t, db, "note1", "owner1")
		insertNote(t, db, "note2", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertShare(t, db, "share2", "note1", "collab2", "owner1")
		insertShare(t, db, "share3", "note2", "collab1", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "owner1")
		insertItem(t, db, "item2", "note2", "Task B", 0, "owner1")

		tx, err := db.Begin()
		require.NoError(t, err)
		require.NoError(t, store.ClearUserAssignmentsTx(tx, "collab1"))
		require.NoError(t, tx.Commit())

		assert.Equal(t, "owner1", getAssignment(t, db, "item1"), "note1 still has collab2 share; owner assignment preserved")
		assert.Empty(t, getAssignment(t, db, "item2"), "note2 lost its only share; owner assignment cleared")
	})

	t.Run("handles user with no assignments", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "")

		tx, err := db.Begin()
		require.NoError(t, err)
		require.NoError(t, store.ClearUserAssignmentsTx(tx, "collab1"))
		require.NoError(t, tx.Commit())

		assert.Empty(t, getAssignment(t, db, "item1"))
	})

	t.Run("clears assignments across multiple notes", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertUser(t, db, "collab2", "collab2")
		insertNote(t, db, "note1", "owner1")
		insertNote(t, db, "note2", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertShare(t, db, "share2", "note1", "collab2", "owner1")
		insertShare(t, db, "share3", "note2", "collab1", "owner1")
		insertShare(t, db, "share4", "note2", "collab2", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "collab1")
		insertItem(t, db, "item2", "note2", "Task B", 0, "collab1")
		insertItem(t, db, "item3", "note2", "Task C", 1, "collab2")

		tx, err := db.Begin()
		require.NoError(t, err)
		require.NoError(t, store.ClearUserAssignmentsTx(tx, "collab1"))
		require.NoError(t, tx.Commit())

		assert.Empty(t, getAssignment(t, db, "item1"), "collab1 assignment cleared on note1")
		assert.Empty(t, getAssignment(t, db, "item2"), "collab1 assignment cleared on note2")
		assert.Equal(t, "collab2", getAssignment(t, db, "item3"), "collab2 assignment untouched")
	})
}

func TestUnshareNoteAssignmentCleanup(t *testing.T) {
	t.Run("clears unshared user assignments", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertUser(t, db, "collab2", "collab2")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertShare(t, db, "share2", "note1", "collab2", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "collab1")
		insertItem(t, db, "item2", "note1", "Task B", 1, "collab2")

		require.NoError(t, store.UnshareNote("note1", "collab1"))

		assert.Empty(t, getAssignment(t, db, "item1"), "unshared user's assignment should be cleared")
		assert.Equal(t, "collab2", getAssignment(t, db, "item2"), "other user's assignment should remain")
	})

	t.Run("clears all assignments when last collaborator is unshared", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "owner1")
		insertItem(t, db, "item2", "note1", "Task B", 1, "collab1")

		require.NoError(t, store.UnshareNote("note1", "collab1"))

		assert.Empty(t, getAssignment(t, db, "item1"), "owner self-assignment should be cleared when note becomes unshared")
		assert.Empty(t, getAssignment(t, db, "item2"), "collab assignment should be cleared")
	})

	t.Run("returns error for non-existent share", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertNote(t, db, "note1", "owner1")

		err := store.UnshareNote("note1", "collab1")
		assert.ErrorIs(t, err, ErrNoteShareNotFound)
	})

	t.Run("only affects items on the target note", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertNote(t, db, "note1", "owner1")
		insertNote(t, db, "note2", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertShare(t, db, "share2", "note2", "collab1", "owner1")
		insertItem(t, db, "item1", "note1", "Task A", 0, "collab1")
		insertItem(t, db, "item2", "note2", "Task B", 0, "collab1")

		require.NoError(t, store.UnshareNote("note1", "collab1"))

		assert.Empty(t, getAssignment(t, db, "item1"), "assignment cleared on unshared note")
		assert.Equal(t, "collab1", getAssignment(t, db, "item2"), "assignment on other note untouched")
	})

	t.Run("preserves unassigned items", func(t *testing.T) {
		db := setupTestDB(t)
		store := NewNoteStore(db)

		insertUser(t, db, "owner1", "owner")
		insertUser(t, db, "collab1", "collab1")
		insertUser(t, db, "collab2", "collab2")
		insertNote(t, db, "note1", "owner1")
		insertShare(t, db, "share1", "note1", "collab1", "owner1")
		insertShare(t, db, "share2", "note1", "collab2", "owner1")
		insertItem(t, db, "item1", "note1", "Unassigned", 0, "")
		insertItem(t, db, "item2", "note1", "Assigned", 1, "collab1")

		require.NoError(t, store.UnshareNote("note1", "collab1"))

		assert.Empty(t, getAssignment(t, db, "item1"), "unassigned item stays unassigned")
		assert.Empty(t, getAssignment(t, db, "item2"), "collab1 assignment cleared")
	})
}
