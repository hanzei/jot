package models

import (
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
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
// without regard to case on every backend. SQLite gets that from COLLATE
// NOCASE, PostgreSQL from a unique index on LOWER(name); both must reject the
// same writes, so the assertions here run against each driver unchanged.
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

		t.Run("names differing only in non-ASCII case are distinct labels", func(t *testing.T) {
			// SQLite's fold covers ASCII A-Z only and cannot be made
			// Unicode-aware without ICU, so PostgreSQL is held to the same rule.
			// Both the lookup and the unique index must agree on it, or
			// GetOrCreateLabel would return a label the index does not consider
			// a conflict.
			store, userID := newTestLabelStore(t, driver)
			ctx := t.Context()

			upper, wasCreated, err := store.GetOrCreateLabel(ctx, userID, "ÄPFEL")
			require.NoError(t, err)
			assert.True(t, wasCreated)

			lower, wasCreated, err := store.GetOrCreateLabel(ctx, userID, "äpfel")
			require.NoError(t, err)
			assert.True(t, wasCreated, "a non-ASCII case difference is a separate label, so this inserts")

			assert.NotEqual(t, upper.ID, lower.ID)
			assert.Equal(t, "äpfel", lower.Name)

			labels, err := store.GetLabels(ctx, userID)
			require.NoError(t, err)
			assert.Len(t, labels, 2)
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
