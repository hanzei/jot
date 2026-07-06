package database

import (
	"database/sql"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/golang-migrate/migrate/v4"
	migratedatabase "github.com/golang-migrate/migrate/v4/database"
	postgresmigrate "github.com/golang-migrate/migrate/v4/database/postgres"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/database/dsntest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newMigrator returns a migrate instance bound to the embedded migration
// source for driver, so a test can step to a specific schema version rather
// than always running every migration.
func newMigrator(t *testing.T, db *sql.DB, driver string) *migrate.Migrate {
	t.Helper()

	var (
		src      source.Driver
		dbDriver migratedatabase.Driver
		err      error
	)

	switch driver {
	case driverSQLite:
		src, err = iofs.New(sqliteMigrationsFS, "migrations/sqlite")
		require.NoError(t, err)
		dbDriver, err = sqlitemigrate.WithInstance(db, &sqlitemigrate.Config{})
		require.NoError(t, err)
	case driverPostgres:
		src, err = iofs.New(postgresMigrationsFS, "migrations/postgres")
		require.NoError(t, err)
		// See the equivalent comment in database.go's runMigrations: check out
		// and release the connection ourselves via WithConnection, rather than
		// letting WithInstance hold it (and leak it) for db's whole lifetime.
		conn, connErr := db.Conn(t.Context())
		require.NoError(t, connErr)
		t.Cleanup(func() { _ = conn.Close() })
		dbDriver, err = postgresmigrate.WithConnection(t.Context(), conn, &postgresmigrate.Config{})
		require.NoError(t, err)
	default:
		t.Fatalf("newMigrator: unsupported driver %q", driver)
	}

	m, err := migrate.NewWithInstance("iofs", src, driver, dbDriver)
	require.NoError(t, err)
	return m
}

// TestMigration000002Backfill exercises the irreversible parent_id backfill in
// 000002: it migrates to the pre-backfill schema (v1), seeds legacy
// indent_level data, then applies 000002 and asserts every item received the
// correct parent_id. This guards against silently mangling existing users'
// groups on upgrade, since 000002 drops indent_level after backfilling.
func TestMigration000002Backfill(t *testing.T) {
	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dsntest.RawDB(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		m := newMigrator(t, db, driver)

		// Step to v1 (initial schema, indent_level still present).
		require.NoError(t, m.Migrate(1))

		// Seed a user and two notes worth of legacy indent_level data.
		_, err := db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES ('user000000000000000001', 'alice', 'x')`))
		require.NoError(t, err)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000001', 'user000000000000000001', 'list')`))
		require.NoError(t, err)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO notes (id, user_id, note_type) VALUES ('note000000000000000002', 'user000000000000000001', 'list')`))
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
				d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, indent_level) VALUES (?, ?, ?, ?, ?)`),
				it.id, it.noteID, it.id, it.position, it.indentLevel,
			)
			require.NoError(t, err)
		}

		// Apply 000002: backfill parent_id, then drop indent_level.
		require.NoError(t, m.Migrate(2))

		parentOf := func(id string) (string, bool) {
			var p sql.NullString
			require.NoError(t, db.QueryRowContext(ctx, d.RewritePlaceholders(`SELECT parent_id FROM note_items WHERE id = ?`), id).Scan(&p))
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
	})
}

// TestMigration000004FixCompletedParentWithIncompleteChild seeds data in the
// invalid state the checklist invariant now forbids (a completed top-level
// item with an incomplete child — e.g. left behind by unchecking a child
// before the cascade-up fix in ToggleItemCompleted/PatchItem), then applies
// 000004 and asserts it's healed without touching unrelated items.
func TestMigration000004FixCompletedParentWithIncompleteChild(t *testing.T) {
	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dsntest.RawDB(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		m := newMigrator(t, db, driver)
		require.NoError(t, m.Migrate(3))

		_, err := db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES ('user000000000000000002', 'bob', 'x')`))
		require.NoError(t, err)
		// A deliberately stale updated_at, so the assertions below can tell whether
		// the migration bumped it (every other note_items mutation path does, via
		// touchNoteTx — this backfill should be no exception).
		staleTimestamp := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO notes (id, user_id, note_type, updated_at) VALUES ('note000000000000000003', 'user000000000000000002', 'list', ?)`), staleTimestamp)
		require.NoError(t, err)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO notes (id, user_id, note_type, updated_at) VALUES ('note000000000000000004', 'user000000000000000002', 'list', ?)`), staleTimestamp)
		require.NoError(t, err)

		// "Done" is completed but has an incomplete child "Undone child" — the
		// invalid state, on note 3. "Fine" is completed with only completed
		// children, and "Untouched" is a plain incomplete top-level item — neither
		// should change — placed on note 4 so its updated_at serves as a control:
		// only note 3 (which actually gets healed) should be bumped.
		seed := []struct {
			id        string
			noteID    string
			parentID  sql.NullString
			completed bool
		}{
			{"itemDone0000000000001", "note000000000000000003", sql.NullString{}, true},
			{"itemDoneChild000000001", "note000000000000000003", sql.NullString{String: "itemDone0000000000001", Valid: true}, true},
			{"itemUndoneChild0000001", "note000000000000000003", sql.NullString{String: "itemDone0000000000001", Valid: true}, false},
			{"itemFine0000000000001", "note000000000000000004", sql.NullString{}, true},
			{"itemFineChild000000001", "note000000000000000004", sql.NullString{String: "itemFine0000000000001", Valid: true}, true},
			{"itemUntouched000000001", "note000000000000000004", sql.NullString{}, false},
		}
		for _, it := range seed {
			_, err = db.ExecContext(ctx,
				d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position, parent_id, completed) VALUES (?, ?, ?, 0, ?, ?)`),
				it.id, it.noteID, it.id, it.parentID, it.completed,
			)
			require.NoError(t, err)
		}

		noteUpdatedAt := func(id string) time.Time {
			var updatedAt time.Time
			require.NoError(t, db.QueryRowContext(ctx, d.RewritePlaceholders(`SELECT updated_at FROM notes WHERE id = ?`), id).Scan(&updatedAt))
			return updatedAt
		}
		// Read back the stale timestamp as the driver actually stored/normalized
		// it, rather than comparing against the literal value inserted above.
		staleAsStored := noteUpdatedAt("note000000000000000003")

		require.NoError(t, m.Migrate(4))

		completedOf := func(id string) bool {
			var completed bool
			require.NoError(t, db.QueryRowContext(ctx, d.RewritePlaceholders(`SELECT completed FROM note_items WHERE id = ?`), id).Scan(&completed))
			return completed
		}

		assert.False(t, completedOf("itemDone0000000000001"), "parent with an incomplete child is un-completed")
		assert.False(t, completedOf("itemUndoneChild0000001"), "the incomplete child is untouched")
		assert.True(t, completedOf("itemDoneChild000000001"), "the completed sibling is untouched")
		assert.True(t, completedOf("itemFine0000000000001"), "a parent whose children are all completed is untouched")
		assert.True(t, completedOf("itemFineChild000000001"))
		assert.False(t, completedOf("itemUntouched000000001"))

		assert.NotEqual(t, staleAsStored, noteUpdatedAt("note000000000000000003"), "the healed note's updated_at is bumped, like any other note_items mutation")
		assert.Equal(t, staleAsStored, noteUpdatedAt("note000000000000000004"), "a note with no invariant violation is left untouched")
	})
}

// TestMigration000007Backfill seeds notes and list items at the pre-FTS schema
// (v6), applies 000007, and asserts the full-text index was backfilled so
// existing installations become searchable on upgrade with no action — across
// note title, content, and item text, including multi-word matches that span a
// note's title and one of its items.
func TestMigration000007Backfill(t *testing.T) {
	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dsntest.RawDB(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		m := newMigrator(t, db, driver)

		// Step to v6 — before the note_search index exists.
		require.NoError(t, m.Migrate(6))

		_, err := db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES ('user000000000000000001', 'alice', 'x')`))
		require.NoError(t, err)
		// A text note (title + content) and a list note whose match term lives
		// only in an item.
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type) VALUES ('note000000000000000001', 'user000000000000000001', 'Weekend', 'buy pineapple', 'text')`))
		require.NoError(t, err)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO notes (id, user_id, title, content, note_type) VALUES ('note000000000000000002', 'user000000000000000001', 'Groceries', '', 'list')`))
		require.NoError(t, err)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`INSERT INTO note_items (id, note_id, text, position) VALUES ('item00000000000000001', 'note000000000000000002', 'fresh avocado', 0)`))
		require.NoError(t, err)

		// Apply 000007: create the index structures and backfill from existing rows.
		require.NoError(t, m.Migrate(7))

		// search returns the note IDs matching query against the backfilled index,
		// using each backend's native full-text engine.
		search := func(query string) []string {
			var q string
			switch driver {
			case driverPostgres:
				q = d.RewritePlaceholders(`SELECT note_id FROM note_search, to_tsquery('simple', ?) tsq WHERE search_tsv @@ tsq ORDER BY note_id`)
			default:
				q = `SELECT note_id FROM note_search WHERE note_search MATCH ? ORDER BY note_id`
			}
			matchExpr := d.FullTextMatchExpr(buildQueryTokens(query))
			rows, err := db.QueryContext(ctx, q, matchExpr)
			require.NoError(t, err)
			defer func() { _ = rows.Close() }()
			var ids []string
			for rows.Next() {
				var id string
				require.NoError(t, rows.Scan(&id))
				ids = append(ids, id)
			}
			require.NoError(t, rows.Err())
			return ids
		}

		assert.Equal(t, []string{"note000000000000000001"}, search("pineapple"), "content backfilled")
		assert.Equal(t, []string{"note000000000000000002"}, search("avocado"), "item text backfilled")
		assert.Equal(t, []string{"note000000000000000001"}, search("weekend pineapple"), "title+content multi-word")
	})
}

// buildQueryTokens mirrors the store's query tokenizer for migration-level
// search assertions: lowercase, split on non-alphanumeric runes.
func buildQueryTokens(query string) []string {
	tokens := strings.FieldsFunc(query, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for i, tok := range tokens {
		tokens[i] = strings.ToLower(tok)
	}
	return tokens
}
