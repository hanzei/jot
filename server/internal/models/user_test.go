package models

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"testing"
	"time"

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

		alice, err := store.Create(ctx, "alice", "password123", "")
		require.NoError(t, err)
		_, err = store.UpdateProfile(ctx, alice.ID, "alice", "Alice", "Anderson")
		require.NoError(t, err)

		bob, err := store.Create(ctx, "bob", "password123", "")
		require.NoError(t, err)
		_, err = store.UpdateProfile(ctx, bob.ID, "bob", "Bob", "Brown")
		require.NoError(t, err)

		t.Run("username matches regardless of the casing typed", func(t *testing.T) {
			for _, term := range []string{"alice", "Alice", "ALICE", "LIC"} {
				found, err := store.Search(ctx, term, "", 50)
				require.NoError(t, err)
				assert.Equal(t, []string{"alice"}, usernamesOf(found), "searching %q", term)
			}
		})

		t.Run("first and last name match regardless of casing", func(t *testing.T) {
			// Names stay free-form mixed case, so they need the fold even though
			// usernames are stored lower case.
			for _, term := range []string{"anderson", "ANDERSON", "aNdErSoN"} {
				found, err := store.Search(ctx, term, "", 50)
				require.NoError(t, err)
				assert.Equal(t, []string{"alice"}, usernamesOf(found), "searching %q", term)
			}

			found, err := store.Search(ctx, "bOb", "", 50)
			require.NoError(t, err)
			assert.Equal(t, []string{"bob"}, usernamesOf(found))
		})

		t.Run("a term matching nobody returns no users", func(t *testing.T) {
			found, err := store.Search(ctx, "carol", "", 50)
			require.NoError(t, err)
			assert.Empty(t, found)
		})
	})
}

func TestUserSearchExcludesAndLimits(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestUserStore(t, driver)
		ctx := t.Context()

		ids := make([]string, 0, 3)
		for _, name := range []string{"match1", "match2", "match3"} {
			u, err := store.Create(ctx, name, "password123", "")
			require.NoError(t, err)
			ids = append(ids, u.ID)
		}

		t.Run("excludes the given user", func(t *testing.T) {
			found, err := store.Search(ctx, "match", ids[0], 50)
			require.NoError(t, err)
			assert.ElementsMatch(t, []string{"match2", "match3"}, usernamesOf(found))
		})

		t.Run("returns at most limit users", func(t *testing.T) {
			found, err := store.Search(ctx, "match", "", 2)
			require.NoError(t, err)
			assert.Len(t, found, 2)
		})
	})
}

func TestConcurrentFirstUserGetsExactlyOneAdmin(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		const n = 8
		adminCount := func(t *testing.T, users []*User) int {
			admins := 0
			for _, u := range users {
				if u.Role == RoleAdmin {
					admins++
				}
			}
			return admins
		}
		run := func(t *testing.T, create func(store *userStore, i int) (*User, error)) []*User {
			store := newTestUserStore(t, driver)
			users := make([]*User, n)
			errs := make([]error, n)
			var wg sync.WaitGroup
			start := make(chan struct{})
			for i := range n {
				wg.Go(func() {
					<-start
					users[i], errs[i] = create(store, i)
				})
			}
			close(start)
			wg.Wait()
			for _, err := range errs {
				require.NoError(t, err)
			}
			return users
		}

		t.Run("Create", func(t *testing.T) {
			users := run(t, func(s *userStore, i int) (*User, error) {
				return s.Create(t.Context(), fmt.Sprintf("user%d", i), "password123", "")
			})
			assert.Equal(t, 1, adminCount(t, users))
		})

		t.Run("ProvisionSSOUser", func(t *testing.T) {
			users := run(t, func(s *userStore, i int) (*User, error) {
				return s.ProvisionSSOUser(t.Context(), testIssuer, fmt.Sprintf("sub-%d", i), fmt.Sprintf("sso%d", i), true)
			})
			assert.Equal(t, 1, adminCount(t, users))
		})
	})
}

// TestConcurrentAdminSelfDeletesKeepAnAdmin covers two admins each deleting
// their own account at once. Without locking the admin rows, both
// transactions count two admins under Postgres's READ COMMITTED and both
// commit, leaving none.
func TestConcurrentAdminSelfDeletesKeepAnAdmin(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestUserStore(t, driver)
		a, err := store.Create(t.Context(), "admina", "password123", RoleAdmin)
		require.NoError(t, err)
		b, err := store.Create(t.Context(), "adminb", "password123", RoleAdmin)
		require.NoError(t, err)

		// A holds its transaction open after the last-admin check until B has
		// had time to reach its own check.
		aChecked := make(chan struct{})
		releaseA := make(chan struct{})
		var errA, errB error
		var wg sync.WaitGroup
		wg.Go(func() {
			errA = store.DeleteWithCleanup(t.Context(), a.ID, func(context.Context, *sql.Tx) error {
				close(aChecked)
				<-releaseA
				return nil
			}, nil)
		})
		<-aChecked
		wg.Go(func() {
			errB = store.DeleteWithCleanup(t.Context(), b.ID, nil, nil)
		})
		time.Sleep(200 * time.Millisecond) //nolint:forbidigo // give B time to reach the lock; the assertion holds whatever the timing
		close(releaseA)
		wg.Wait()

		require.NoError(t, errA)
		require.Error(t, errB, "the second self-delete must not succeed once the first commits")
		if driver == dialect.DriverPostgres {
			require.ErrorIs(t, errB, ErrLastAdminDelete)
		}

		var admins int
		require.NoError(t, store.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&admins))
		assert.Equal(t, 1, admins)
	})
}

func TestCreateExplicitRole(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestUserStore(t, driver)
		first, err := store.Create(t.Context(), "first", "password123", RoleUser)
		require.NoError(t, err)
		assert.Equal(t, RoleUser, first.Role, "an explicit role overrides first-user admin")
		second, err := store.Create(t.Context(), "second", "password123", RoleAdmin)
		require.NoError(t, err)
		assert.Equal(t, RoleAdmin, second.Role)
	})
}
