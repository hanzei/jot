package database

import (
	"database/sql"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newMigrator opens a fresh SQLite database at dsn and returns a migrate
// instance bound to the embedded SQLite migration source, so a test can step to
// a specific schema version rather than always running every migration.
func newMigrator(t *testing.T, db *sql.DB) *migrate.Migrate {
	t.Helper()

	src, err := iofs.New(sqliteMigrationsFS, "migrations/sqlite")
	require.NoError(t, err)

	dbDriver, err := sqlitemigrate.WithInstance(db, &sqlitemigrate.Config{})
	require.NoError(t, err)

	m, err := migrate.NewWithInstance("iofs", src, "sqlite", dbDriver)
	require.NoError(t, err)
	return m
}

// TestMigration000002Backfill exercises the irreversible parent_id backfill in
// 000002: it migrates to the pre-backfill schema (v1), seeds legacy
// indent_level data, then applies 000002 and asserts every item received the
// correct parent_id. This guards against silently mangling existing users'
// groups on upgrade, since 000002 drops indent_level after backfilling.
func TestMigration000002Backfill(t *testing.T) {
	dsn := t.TempDir() + "/backfill.db"
	db, err := sql.Open("sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	// Serialize access like production so modernc.org/sqlite doesn't deadlock.
	db.SetMaxOpenConns(1)
	ctx := t.Context()
	_, err = db.ExecContext(ctx, `PRAGMA foreign_keys = ON`)
	require.NoError(t, err)

	m := newMigrator(t, db)

	// Step to v1 (initial schema, indent_level still present).
	require.NoError(t, m.Migrate(1))

	// Seed a user and two notes worth of legacy indent_level data.
	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES ('user000000000000000001', 'alice', 'x')`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000001', 'user000000000000000001', 'list')`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000002', 'user000000000000000001', 'list')`)
	require.NoError(t, err)

	// Note 1 layout (by position):
	//   0 top-level A (indent 0)
	//   1 child  A1   (indent 1) -> A
	//   2 child  A2   (indent 1) -> A
	//   3 top-level B (indent 0)
	//   4 child  B1   (indent 1) -> B   (nearest preceding top-level, not A)
	seed := []struct {
		id          string
		noteID      string
		position    int
		indentLevel int
	}{
		{"itemA00000000000000001", "note000000000000000001", 0, 0},
		{"itemA10000000000000001", "note000000000000000001", 1, 1},
		{"itemA20000000000000001", "note000000000000000001", 2, 1},
		{"itemB00000000000000001", "note000000000000000001", 3, 0},
		{"itemB10000000000000001", "note000000000000000001", 4, 1},
		// Note 2: a leading indented item with no preceding top-level item.
		{"itemLonely000000000001", "note000000000000000002", 0, 1},
	}
	for _, it := range seed {
		_, err = db.ExecContext(ctx,
			`INSERT INTO note_items (id, note_id, text, position, indent_level) VALUES (?, ?, ?, ?, ?)`,
			it.id, it.noteID, it.id, it.position, it.indentLevel,
		)
		require.NoError(t, err)
	}

	// Apply 000002: backfill parent_id, then drop indent_level.
	require.NoError(t, m.Migrate(2))

	parentOf := func(id string) (string, bool) {
		var p sql.NullString
		require.NoError(t, db.QueryRowContext(ctx, `SELECT parent_id FROM note_items WHERE id = ?`, id).Scan(&p))
		return p.String, p.Valid
	}

	// Top-level items stay NULL.
	_, ok := parentOf("itemA00000000000000001")
	assert.False(t, ok, "top-level A stays top-level")
	_, ok = parentOf("itemB00000000000000001")
	assert.False(t, ok, "top-level B stays top-level")

	// Children attach to the nearest preceding top-level item by position.
	p, ok := parentOf("itemA10000000000000001")
	assert.True(t, ok)
	assert.Equal(t, "itemA00000000000000001", p)
	p, ok = parentOf("itemA20000000000000001")
	assert.True(t, ok)
	assert.Equal(t, "itemA00000000000000001", p)
	p, ok = parentOf("itemB10000000000000001")
	assert.True(t, ok)
	assert.Equal(t, "itemB00000000000000001", p, "child attaches to B, the nearest preceding top-level")

	// An indented item with no preceding top-level item stays top-level.
	_, ok = parentOf("itemLonely000000000001")
	assert.False(t, ok, "leading indented item has no parent to attach to")

	// indent_level must be gone after the migration.
	var dummy int
	err = db.QueryRowContext(ctx, `SELECT indent_level FROM note_items LIMIT 1`).Scan(&dummy)
	require.Error(t, err, "indent_level column should be dropped")
	assert.Contains(t, err.Error(), "indent_level")
}
