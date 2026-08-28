package database

import (
	"context"
	"database/sql"
	"testing"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/database/dsntest"
	"github.com/hanzei/jot/server/internal/labelfold"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seedPreFoldLabels recreates the state an installation is in just before the
// backfill runs: labels.name_folded exists but is empty, and the unique index
// over it does not exist yet. Dropping the index is what makes the fixture
// possible — with it in place the duplicate rows could not be inserted, which
// is the whole reason the merge has to happen before it is created.
func seedPreFoldLabels(ctx context.Context, t *testing.T, db *sql.DB, d *dialect.Dialect) {
	t.Helper()

	_, err := db.ExecContext(ctx, `DROP INDEX IF EXISTS `+labelNameFoldedIndex)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `UPDATE labels SET name_folded = ''`)
	require.NoError(t, err)

	_, err = db.ExecContext(ctx, d.RewritePlaceholders(
		`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
		"user0000000000000fold", "folduser", "x")
	require.NoError(t, err)

	// Two notes to hang associations off.
	for _, id := range []string{"note0000000000000one", "note0000000000000two"} {
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(
			`INSERT INTO notes (id, user_id, note_type) VALUES (?, ?, ?)`),
			id, "user0000000000000fold", "text")
		require.NoError(t, err)
	}

	// created_at decides which row survives a merge, so it is set explicitly.
	labels := []struct{ id, name, createdAt string }{
		{"labl0000000000000ae01", "Äpfel", "2024-01-01 00:00:00"},
		{"labl0000000000000ae02", "äpfel", "2024-01-02 00:00:00"},
		{"labl0000000000000ss01", "Straße", "2024-01-01 00:00:00"},
		{"labl0000000000000ss02", "STRASSE", "2024-01-02 00:00:00"},
		{"labl00000000000work01", "Work", "2024-01-01 00:00:00"},
		{"labl00000000000alone1", "Reisen", "2024-01-01 00:00:00"},
	}
	for _, l := range labels {
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(
			`INSERT INTO labels (id, user_id, name, name_folded, created_at) VALUES (?, ?, ?, '', ?)`),
			l.id, "user0000000000000fold", l.name, l.createdAt)
		require.NoError(t, err, "seed label %q", l.name)
	}

	// note one carries both Äpfel spellings — the merge must collapse the two
	// associations into one rather than violating note_labels' uniqueness.
	assocs := []struct{ id, noteID, labelID string }{
		{"nlbl0000000000000001", "note0000000000000one", "labl0000000000000ae01"},
		{"nlbl0000000000000002", "note0000000000000one", "labl0000000000000ae02"},
		{"nlbl0000000000000003", "note0000000000000two", "labl0000000000000ae02"},
		{"nlbl0000000000000004", "note0000000000000two", "labl0000000000000ss02"},
	}
	for _, a := range assocs {
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(
			`INSERT INTO note_labels (id, note_id, label_id, user_id) VALUES (?, ?, ?, ?)`),
			a.id, a.noteID, a.labelID, "user0000000000000fold")
		require.NoError(t, err)
	}
}

func TestBackfillLabelNameFolded(t *testing.T) {
	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := newMigratedDB(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		seedPreFoldLabels(ctx, t, db, d)
		require.NoError(t, backfillLabelNameFolded(ctx, db, driver))

		t.Run("duplicates are merged into the oldest label", func(t *testing.T) {
			var names []string
			rows, err := db.QueryContext(ctx, d.RewritePlaceholders(
				`SELECT name FROM labels WHERE user_id = ? ORDER BY name`), "user0000000000000fold")
			require.NoError(t, err)
			defer func() { _ = rows.Close() }()
			for rows.Next() {
				var name string
				require.NoError(t, rows.Scan(&name))
				names = append(names, name)
			}
			require.NoError(t, rows.Err())

			// The younger spelling of each pair is gone; everything else stays.
			assert.ElementsMatch(t, []string{"Äpfel", "Straße", "Work", "Reisen"}, names)
		})

		t.Run("every row carries the key its name folds to", func(t *testing.T) {
			rows, err := db.QueryContext(ctx, `SELECT name, name_folded FROM labels`)
			require.NoError(t, err)
			defer func() { _ = rows.Close() }()
			for rows.Next() {
				var name, folded string
				require.NoError(t, rows.Scan(&name, &folded))
				assert.Equal(t, labelfold.Fold(name), folded,
					"stored key for %q disagrees with labelfold.Fold", name)
			}
			require.NoError(t, rows.Err())
		})

		t.Run("no note loses a tag", func(t *testing.T) {
			// note one had both Äpfel spellings and keeps exactly one
			// association; note two had äpfel and STRASSE and keeps both,
			// repointed at the survivors.
			labelIDsForNote := func(noteID string) []string {
				rows, err := db.QueryContext(ctx, d.RewritePlaceholders(
					`SELECT label_id FROM note_labels WHERE note_id = ?`), noteID)
				require.NoError(t, err)
				defer func() { _ = rows.Close() }()

				var got []string
				for rows.Next() {
					var id string
					require.NoError(t, rows.Scan(&id))
					got = append(got, id)
				}
				require.NoError(t, rows.Err())
				return got
			}

			for _, tt := range []struct {
				noteID string
				want   []string
			}{
				{"note0000000000000one", []string{"labl0000000000000ae01"}},
				{"note0000000000000two", []string{"labl0000000000000ae01", "labl0000000000000ss01"}},
			} {
				assert.ElementsMatch(t, tt.want, labelIDsForNote(tt.noteID), "associations for %s", tt.noteID)
			}
		})

		t.Run("the unique index is in place afterwards", func(t *testing.T) {
			exists, err := labelNameFoldedIndexExists(ctx, db, driver)
			require.NoError(t, err)
			assert.True(t, exists)

			_, err = db.ExecContext(ctx, d.RewritePlaceholders(
				`INSERT INTO labels (id, user_id, name, name_folded) VALUES (?, ?, ?, ?)`),
				"labl000000000000dupe1", "user0000000000000fold", "ÄPFEL", labelfold.Fold("ÄPFEL"))
			require.Error(t, err)
			assert.True(t, d.IsUniqueConstraintError(err), "want a unique violation, got %v", err)
		})

		t.Run("running again is a no-op", func(t *testing.T) {
			require.NoError(t, backfillLabelNameFolded(ctx, db, driver))

			var count int
			require.NoError(t, db.QueryRowContext(ctx, d.RewritePlaceholders(
				`SELECT COUNT(*) FROM labels WHERE user_id = ?`), "user0000000000000fold").Scan(&count))
			assert.Equal(t, 4, count)
		})
	})
}

// TestBackfillLabelNameFoldedOnFreshDatabase covers the path every new
// installation takes: New() runs it against an empty labels table, and it has
// to leave the same schema behind as an upgrade does.
func TestBackfillLabelNameFoldedOnFreshDatabase(t *testing.T) {
	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := newMigratedDB(t, driver)
		ctx := t.Context()

		exists, err := labelNameFoldedIndexExists(ctx, db, driver)
		require.NoError(t, err)
		assert.True(t, exists, "New() must leave the unique index in place")
	})
}
