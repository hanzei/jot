package models

import (
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestUserStore opens a fresh migrated database for driver and returns a
// userStore bound to it.
func newTestUserStore(t *testing.T, driver string) *userStore {
	t.Helper()

	db := dbtest.New(t, driver)
	return newUserStore(db, &dialect.Dialect{Driver: driver})
}

// usernamesOf collects the usernames of a search result, so assertions read as
// sets rather than as index arithmetic over the ordered slice.
func usernamesOf(users []*User) []string {
	names := make([]string, 0, len(users))
	for _, u := range users {
		names = append(names, u.Username)
	}
	return names
}

// TestUserSearchIsCaseInsensitive locks the share and assignee pickers to the
// same matching rule on both backends. A plain LIKE folds ASCII case on SQLite
// and not on PostgreSQL, so this only fails on the backend the HTTP suite never
// exercises — which is exactly why the assertions run against each driver.
func TestUserSearchIsCaseInsensitive(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestUserStore(t, driver)
		ctx := t.Context()

		alice, err := store.Create(ctx, "alice", "password123")
		require.NoError(t, err)
		_, err = store.UpdateProfile(ctx, alice.ID, "alice", "Alice", "Anderson")
		require.NoError(t, err)

		bob, err := store.Create(ctx, "bob", "password123")
		require.NoError(t, err)
		_, err = store.UpdateProfile(ctx, bob.ID, "bob", "Bob", "Brown")
		require.NoError(t, err)

		t.Run("username matches regardless of the casing typed", func(t *testing.T) {
			for _, term := range []string{"alice", "Alice", "ALICE", "LIC"} {
				found, err := store.Search(ctx, term)
				require.NoError(t, err)
				assert.Equal(t, []string{"alice"}, usernamesOf(found), "searching %q", term)
			}
		})

		t.Run("first and last name match regardless of casing", func(t *testing.T) {
			// Names stay free-form mixed case, so they need the fold even though
			// usernames are stored lower case.
			for _, term := range []string{"anderson", "ANDERSON", "aNdErSoN"} {
				found, err := store.Search(ctx, term)
				require.NoError(t, err)
				assert.Equal(t, []string{"alice"}, usernamesOf(found), "searching %q", term)
			}

			found, err := store.Search(ctx, "bOb")
			require.NoError(t, err)
			assert.Equal(t, []string{"bob"}, usernamesOf(found))
		})

		t.Run("a term matching nobody returns no users", func(t *testing.T) {
			found, err := store.Search(ctx, "carol")
			require.NoError(t, err)
			assert.Empty(t, found)
		})
	})
}
