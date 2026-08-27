package models

import (
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/labelfold"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestLabelStore opens a fresh migrated database for driver and returns a
// labelStore bound to it plus an owning user ID.
func newTestLabelStore(t *testing.T, driver string) (*labelStore, string) {
	t.Helper()

	db := dbtest.New(t, driver)
	d := &dialect.Dialect{Driver: driver}
	store := newLabelStore(db, d)

	_, err := db.ExecContext(t.Context(),
		d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
		"user00000000000000labl", "labeler", "x")
	require.NoError(t, err)

	return store, "user00000000000000labl"
}

// TestLabelNameCaseInsensitivity locks in that label names are unique per user
// without regard to case on every backend. Both get that from the folded key
// in labels.name_folded, computed by labelfold.Fold and compared as a plain
// column, so there is no dialect left to diverge and every assertion here runs
// against each driver unchanged.
func TestLabelNameCaseInsensitivity(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("GetOrCreateLabel returns the existing label for a different casing", func(t *testing.T) {
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			created, wasCreated, err := store.GetOrCreateLabel(ctx, userID, "Work")
			require.NoError(t, err)
			assert.True(t, wasCreated, "the first call inserts the label")

			same, wasCreated, err := store.GetOrCreateLabel(ctx, userID, "wOrK")
			require.NoError(t, err)
			assert.False(t, wasCreated, "a different casing matches the existing label")

			assert.Equal(t, created.ID, same.ID)
			assert.Equal(t, "Work", same.Name, "the stored name keeps its original casing")

			labels, err := store.GetLabels(ctx, userID)
			require.NoError(t, err)
			assert.Len(t, labels, 1)
		})

		t.Run("CreateLabel rejects a name that differs only in case", func(t *testing.T) {
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			_, err := store.CreateLabel(ctx, userID, "labl000000000000000ci1", "Work")
			require.NoError(t, err)

			_, err = store.CreateLabel(ctx, userID, "labl000000000000000ci2", "work")
			assert.ErrorIs(t, err, ErrLabelNameConflict)
		})

		t.Run("CreateLabel reports an ID replay as an ID conflict", func(t *testing.T) {
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			_, err := store.CreateLabel(ctx, userID, "labl000000000000000id1", "Work")
			require.NoError(t, err)

			// Same ID, different name: an offline client replaying its create.
			_, err = store.CreateLabel(ctx, userID, "labl000000000000000id1", "Errands")
			assert.ErrorIs(t, err, ErrLabelIDConflict)
		})

		t.Run("RenameLabel rejects a name that differs only in case", func(t *testing.T) {
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			_, err := store.CreateLabel(ctx, userID, "labl00000000000000rn1", "Work")
			require.NoError(t, err)
			_, err = store.CreateLabel(ctx, userID, "labl00000000000000rn2", "Home")
			require.NoError(t, err)

			_, err = store.RenameLabel(ctx, "labl00000000000000rn2", userID, "WORK")
			assert.ErrorIs(t, err, ErrLabelNameConflict)
		})

		t.Run("names differing only in non-ASCII case are one label", func(t *testing.T) {
			// The fold is labelfold.Fold on both backends, so its reach is
			// Unicode-wide rather than the ASCII A-Z that SQL could manage.
			// Both the lookup and the unique index are driven by the stored
			// key, so they cannot disagree about what counts as a conflict.
			for _, tt := range []struct{ name, first, second string }{
				{"german umlaut", "ÄPFEL", "äpfel"},
				{"german sharp s", "Straße", "STRASSE"},
				{"greek final sigma", "ΣΟΦΟΣ", "σοφος"},
				{"french accent", "Épée", "épée"},
				{"nfc and nfd spellings", "Café", "café"},
			} {
				t.Run(tt.name, func(t *testing.T) {
					store, userID := newTestLabelStore(t, driver)
					ctx := t.Context()

					first, wasCreated, err := store.GetOrCreateLabel(ctx, userID, tt.first)
					require.NoError(t, err)
					assert.True(t, wasCreated)

					second, wasCreated, err := store.GetOrCreateLabel(ctx, userID, tt.second)
					require.NoError(t, err)
					assert.False(t, wasCreated, "%q must match the existing %q", tt.second, tt.first)

					assert.Equal(t, first.ID, second.ID)
					assert.Equal(t, tt.first, second.Name, "the stored name keeps its original spelling")

					labels, err := store.GetLabels(ctx, userID)
					require.NoError(t, err)
					assert.Len(t, labels, 1)
				})
			}
		})

		t.Run("an accent is a different word, not a case variant", func(t *testing.T) {
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			apfel, _, err := store.GetOrCreateLabel(ctx, userID, "Apfel")
			require.NoError(t, err)

			umlaut, wasCreated, err := store.GetOrCreateLabel(ctx, userID, "Äpfel")
			require.NoError(t, err)
			assert.True(t, wasCreated, "folding must not strip accents")
			assert.NotEqual(t, apfel.ID, umlaut.ID)
		})

		t.Run("RenameLabel keeps the folded key in step with the name", func(t *testing.T) {
			// A rename that updated only name would leave the row unreachable
			// by every case-insensitive lookup, and free to be duplicated.
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			_, err := store.CreateLabel(ctx, userID, "labl00000000000000fk1", "Work")
			require.NoError(t, err)

			renamed, err := store.RenameLabel(ctx, "labl00000000000000fk1", userID, "Äpfel")
			require.NoError(t, err)
			assert.Equal(t, "Äpfel", renamed.Name)

			var folded string
			require.NoError(t, store.db.QueryRowContext(ctx,
				store.d.RewritePlaceholders(`SELECT name_folded FROM labels WHERE id = ?`),
				"labl00000000000000fk1").Scan(&folded))
			assert.Equal(t, labelfold.Fold("Äpfel"), folded)

			// And the new spelling now collides, where the old one no longer does.
			_, wasCreated, err := store.GetOrCreateLabel(ctx, userID, "äpfel")
			require.NoError(t, err)
			assert.False(t, wasCreated, "the renamed label must be found by its new folded key")
		})

		t.Run("resolving a label by a different spelling leaves its name alone", func(t *testing.T) {
			// The import and duplicate paths upsert labels by folded key. The
			// conflict branch has to return the existing row without adopting
			// the incoming spelling, or importing a note tagged "äpfel" would
			// rename the user's "Äpfel" label and every other note carrying it.
			db := dbtest.New(t, driver)
			d := &dialect.Dialect{Driver: driver}
			ctx := t.Context()

			_, err := db.ExecContext(ctx,
				d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
				"user00000000000000imp", "importer", "x")
			require.NoError(t, err)

			labels := newLabelStore(db, d)
			existing, _, err := labels.GetOrCreateLabel(ctx, "user00000000000000imp", "Äpfel")
			require.NoError(t, err)

			notes := newNoteStore(db, d)
			require.NoError(t, notes.ImportJotNotes(ctx, "user00000000000000imp", []JotImportNote{{
				Title:    "Einkaufsliste",
				NoteType: NoteTypeText,
				Color:    DefaultNoteColor,
				Labels:   []string{"äpfel"},
			}}))

			after, err := labels.GetLabels(ctx, "user00000000000000imp")
			require.NoError(t, err)
			require.Len(t, after, 1, "the import must reuse the existing label")
			assert.Equal(t, existing.ID, after[0].ID)
			assert.Equal(t, "Äpfel", after[0].Name, "the stored spelling must survive the import")
		})

		t.Run("different users may each own the same name", func(t *testing.T) {
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			_, err := store.db.ExecContext(ctx,
				store.d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
				"user0000000000000labl2", "labeler2", "x")
			require.NoError(t, err)

			mine, _, err := store.GetOrCreateLabel(ctx, userID, "Work")
			require.NoError(t, err)
			theirs, _, err := store.GetOrCreateLabel(ctx, "user0000000000000labl2", "work")
			require.NoError(t, err)

			assert.NotEqual(t, mine.ID, theirs.ID)
		})
	})
}
