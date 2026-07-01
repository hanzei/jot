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

// TestMigration000004FixCompletedParentWithIncompleteChild seeds data in the
// invalid state the checklist invariant now forbids (a completed top-level
// item with an incomplete child — e.g. left behind by unchecking a child
// before the cascade-up fix in ToggleItemCompleted/PatchItem), then applies
// 000004 and asserts it's healed without touching unrelated items.
func TestMigration000004FixCompletedParentWithIncompleteChild(t *testing.T) {
	dsn := t.TempDir() + "/backfill4.db"
	db, err := sql.Open("sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	db.SetMaxOpenConns(1)
	ctx := t.Context()
	_, err = db.ExecContext(ctx, `PRAGMA foreign_keys = ON`)
	require.NoError(t, err)

	m := newMigrator(t, db)
	require.NoError(t, m.Migrate(3))

	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES ('user000000000000000002', 'bob', 'x')`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000003', 'user000000000000000002', 'list')`)
	require.NoError(t, err)

	// "Done" is completed but has an incomplete child "Undone child" — the
	// invalid state. "Fine" is completed with only completed children, and
	// "Untouched" is a plain incomplete top-level item; neither should change.
	seed := []struct {
		id        string
		parentID  sql.NullString
		completed bool
	}{
		{"itemDone0000000000001", sql.NullString{}, true},
		{"itemDoneChild000000001", sql.NullString{String: "itemDone0000000000001", Valid: true}, true},
		{"itemUndoneChild0000001", sql.NullString{String: "itemDone0000000000001", Valid: true}, false},
		{"itemFine0000000000001", sql.NullString{}, true},
		{"itemFineChild000000001", sql.NullString{String: "itemFine0000000000001", Valid: true}, true},
		{"itemUntouched000000001", sql.NullString{}, false},
	}
	for _, it := range seed {
		_, err = db.ExecContext(ctx,
			`INSERT INTO note_items (id, note_id, text, position, parent_id, completed) VALUES (?, ?, ?, 0, ?, ?)`,
			it.id, "note000000000000000003", it.id, it.parentID, it.completed,
		)
		require.NoError(t, err)
	}

	require.NoError(t, m.Migrate(4))

	completedOf := func(id string) bool {
		var completed bool
		require.NoError(t, db.QueryRowContext(ctx, `SELECT completed FROM note_items WHERE id = ?`, id).Scan(&completed))
		return completed
	}

	assert.False(t, completedOf("itemDone0000000000001"), "parent with an incomplete child is un-completed")
	assert.False(t, completedOf("itemUndoneChild0000001"), "the incomplete child is untouched")
	assert.True(t, completedOf("itemDoneChild000000001"), "the completed sibling is untouched")
	assert.True(t, completedOf("itemFine0000000000001"), "a parent whose children are all completed is untouched")
	assert.True(t, completedOf("itemFineChild000000001"))
	assert.False(t, completedOf("itemUntouched000000001"))
}
