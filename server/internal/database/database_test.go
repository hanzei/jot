package database

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewCleansOrphanedRowsDuringMigration(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "pre_upgrade.db")
	seedDB, err := sql.Open("sqlite3", sqliteDSN(dbPath))
	require.NoError(t, err)

	require.NoError(t, seedDB.Ping())

	applyMigrationsBefore(t, seedDB, "019_cleanup_orphaned_foreign_keys.sql")

	seedConn, err := seedDB.Conn(t.Context())
	require.NoError(t, err)

	mustExec(t, seedConn, "PRAGMA foreign_keys = OFF")

	mustExec(t, seedConn, `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, "user-owner", "owner", "hash")
	mustExec(t, seedConn, `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, "user-sharee", "sharee", "hash")
	mustExec(t, seedConn, `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, "user-sharee-2", "sharee2", "hash")

	mustExec(t, seedConn, `INSERT INTO notes (id, user_id, title, content, note_type) VALUES (?, ?, ?, ?, ?)`,
		"note-valid", "user-owner", "valid", "valid", "text")
	mustExec(t, seedConn, `INSERT INTO notes (id, user_id, title, content, note_type) VALUES (?, ?, ?, ?, ?)`,
		"note-orphan-user", "missing-user", "orphan", "orphan", "text")

	mustExec(t, seedConn, `INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)`, "label-valid", "user-owner", "valid")
	mustExec(t, seedConn, `INSERT INTO labels (id, user_id, name) VALUES (?, ?, ?)`, "label-orphan-user", "missing-user", "orphan")

	mustExec(t, seedConn, `INSERT INTO note_items (id, note_id, text, position) VALUES (?, ?, ?, ?)`,
		"item-valid", "note-valid", "valid", 0)
	mustExec(t, seedConn, `INSERT INTO note_items (id, note_id, text, position) VALUES (?, ?, ?, ?)`,
		"item-missing-note", "note-missing", "orphan", 0)
	mustExec(t, seedConn, `INSERT INTO note_items (id, note_id, text, position) VALUES (?, ?, ?, ?)`,
		"item-parent-note-orphan", "note-orphan-user", "cascade", 1)

	mustExec(t, seedConn, `INSERT INTO note_labels (id, note_id, label_id) VALUES (?, ?, ?)`,
		"note-label-valid", "note-valid", "label-valid")
	mustExec(t, seedConn, `INSERT INTO note_labels (id, note_id, label_id) VALUES (?, ?, ?)`,
		"note-label-missing-note", "note-missing", "label-valid")
	mustExec(t, seedConn, `INSERT INTO note_labels (id, note_id, label_id) VALUES (?, ?, ?)`,
		"note-label-missing-label", "note-valid", "label-missing")
	mustExec(t, seedConn, `INSERT INTO note_labels (id, note_id, label_id) VALUES (?, ?, ?)`,
		"note-label-parent-label-orphan", "note-valid", "label-orphan-user")

	mustExec(t, seedConn, `INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level) VALUES (?, ?, ?, ?, 'edit')`,
		"share-valid", "note-valid", "user-sharee", "user-owner")
	mustExec(t, seedConn, `INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level) VALUES (?, ?, ?, ?, 'edit')`,
		"share-missing-note", "note-missing", "user-sharee", "user-owner")
	mustExec(t, seedConn, `INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level) VALUES (?, ?, ?, ?, 'edit')`,
		"share-missing-sharee", "note-valid", "missing-user", "user-owner")
	mustExec(t, seedConn, `INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level) VALUES (?, ?, ?, ?, 'edit')`,
		"share-missing-sharer", "note-valid", "user-sharee-2", "missing-user")
	mustExec(t, seedConn, `INSERT INTO note_shares (id, note_id, shared_with_user_id, shared_by_user_id, permission_level) VALUES (?, ?, ?, ?, 'edit')`,
		"share-parent-note-orphan", "note-orphan-user", "user-sharee-2", "user-owner")

	mustExec(t, seedConn, `INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`,
		"session-valid", "user-owner", time.Now().Add(time.Hour), "")
	mustExec(t, seedConn, `INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`,
		"session-missing-user", "missing-user", time.Now().Add(time.Hour), "")

	mustExec(t, seedConn, `INSERT INTO user_settings (user_id, language, theme, note_sort) VALUES (?, ?, ?, ?)`,
		"user-owner", "system", "system", "manual")
	mustExec(t, seedConn, `INSERT INTO user_settings (user_id, language, theme, note_sort) VALUES (?, ?, ?, ?)`,
		"missing-user", "system", "system", "manual")

	require.NoError(t, seedConn.Close())
	require.NoError(t, seedDB.Close())

	db, err := New(dbPath)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = db.Close()
	})

	assertForeignKeysEnabled(t, db.DB)
	assertNoForeignKeyViolations(t, db.DB)

	assertRecordExists(t, db.DB, "notes", "id", "note-valid")
	assertRecordMissing(t, db.DB, "notes", "id", "note-orphan-user")
	assertRecordExists(t, db.DB, "labels", "id", "label-valid")
	assertRecordMissing(t, db.DB, "labels", "id", "label-orphan-user")

	assertRecordExists(t, db.DB, "note_items", "id", "item-valid")
	assertRecordMissing(t, db.DB, "note_items", "id", "item-missing-note")
	assertRecordMissing(t, db.DB, "note_items", "id", "item-parent-note-orphan")

	assertRecordExists(t, db.DB, "note_labels", "id", "note-label-valid")
	assertRecordMissing(t, db.DB, "note_labels", "id", "note-label-missing-note")
	assertRecordMissing(t, db.DB, "note_labels", "id", "note-label-missing-label")
	assertRecordMissing(t, db.DB, "note_labels", "id", "note-label-parent-label-orphan")

	assertRecordExists(t, db.DB, "note_shares", "id", "share-valid")
	assertRecordMissing(t, db.DB, "note_shares", "id", "share-missing-note")
	assertRecordMissing(t, db.DB, "note_shares", "id", "share-missing-sharee")
	assertRecordMissing(t, db.DB, "note_shares", "id", "share-missing-sharer")
	assertRecordMissing(t, db.DB, "note_shares", "id", "share-parent-note-orphan")

	assertRecordExists(t, db.DB, "sessions", "token", "session-valid")
	assertRecordMissing(t, db.DB, "sessions", "token", "session-missing-user")
	assertRecordExists(t, db.DB, "user_settings", "user_id", "user-owner")
	assertRecordMissing(t, db.DB, "user_settings", "user_id", "missing-user")
}

func applyMigrationsBefore(t *testing.T, db *sql.DB, stopBefore string) {
	t.Helper()

	mustExec(t, db, `CREATE TABLE IF NOT EXISTS migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		filename TEXT UNIQUE NOT NULL,
		applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)

	files, err := migrationsFS.ReadDir("migrations")
	require.NoError(t, err)

	for _, file := range files {
		if file.Name() == stopBefore {
			return
		}

		content, err := migrationsFS.ReadFile("migrations/" + file.Name())
		require.NoError(t, err)

		tx, err := db.Begin()
		require.NoError(t, err)

		_, err = tx.Exec(string(content))
		require.NoError(t, err)

		_, err = tx.Exec(`INSERT INTO migrations (filename) VALUES (?)`, file.Name())
		require.NoError(t, err)

		require.NoError(t, tx.Commit())
	}

	t.Fatalf("did not find migration %q", stopBefore)
}

type contextExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func mustExec(t *testing.T, execer contextExecer, query string, args ...any) {
	t.Helper()

	_, err := execer.ExecContext(t.Context(), query, args...)
	require.NoError(t, err)
}

func assertForeignKeysEnabled(t *testing.T, db *sql.DB) {
	t.Helper()

	var enabled int
	require.NoError(t, db.QueryRow("PRAGMA foreign_keys").Scan(&enabled))
	assert.Equal(t, 1, enabled)
}

func assertNoForeignKeyViolations(t *testing.T, db *sql.DB) {
	t.Helper()

	rows, err := db.Query("PRAGMA foreign_key_check")
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	require.False(t, rows.Next(), "expected foreign_key_check to return no rows")
	require.NoError(t, rows.Err())
}

func assertRecordExists(t *testing.T, db *sql.DB, table, idColumn, id string) {
	t.Helper()

	assert.Equal(t, 1, recordCount(t, db, table, idColumn, id), "%s.%s=%s should remain", table, idColumn, id)
}

func assertRecordMissing(t *testing.T, db *sql.DB, table, idColumn, id string) {
	t.Helper()

	assert.Zero(t, recordCount(t, db, table, idColumn, id), "%s.%s=%s should be removed", table, idColumn, id)
}

func recordCount(t *testing.T, db *sql.DB, table, idColumn, id string) int {
	t.Helper()

	var count int
	query := fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s = ?", table, idColumn)
	require.NoError(t, db.QueryRow(query, id).Scan(&count))
	return count
}
