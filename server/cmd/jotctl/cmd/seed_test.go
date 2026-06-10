package cmd

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSeedCmd(t *testing.T) {
	t.Run("seeds users and notes", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createAdmin(t, "admin", "adminp")

		res := runJotCTL(t, ts, admin, "seed")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "Done.")

		// Verify via API that all seed users were created.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		// admin + 3 seed users (alice, bob, carol)
		require.GreaterOrEqual(t, len(users), 4)
		byUsername := make(map[string]struct{}, len(users))
		for _, u := range users {
			byUsername[u.Username] = struct{}{}
		}
		assert.Contains(t, byUsername, "alice")
		assert.Contains(t, byUsername, "bob")
		assert.Contains(t, byUsername, "carol")
	})

	t.Run("json output", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createAdmin(t, "admin", "adminp")

		res := runJotCTL(t, ts, admin, "--json", "seed")
		require.NoError(t, res.Err)

		var summary seedSummary
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &summary))
		assert.Equal(t, 3, summary.UsersCreated)
		assert.Positive(t, summary.NotesCreated)
	})

	t.Run("is idempotent", func(t *testing.T) {
		ts := setupTestServer(t)
		admin := ts.createAdmin(t, "admin", "adminp")

		res := runJotCTL(t, ts, admin, "--json", "seed")
		require.NoError(t, res.Err)

		// Second seed should create no new users.
		res2 := runJotCTL(t, ts, admin, "--json", "seed")
		require.NoError(t, res2.Err)

		var summary seedSummary
		require.NoError(t, json.Unmarshal([]byte(res2.Stdout), &summary))
		assert.Equal(t, 0, summary.UsersCreated)
	})
}

func TestResetCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminp")

	// Seed first so there's something to reset.
	res := runJotCTL(t, ts, admin, "seed")
	require.NoError(t, res.Err)

	t.Run("deletes non-admin users", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "reset", "--yes")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "Done.")

		// Verify via API that only admin remains.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		assert.Len(t, users, 1)
		assert.Equal(t, "admin", users[0].Username)
	})

	t.Run("json output", func(t *testing.T) {
		// Re-seed so there's something to delete.
		res := runJotCTL(t, ts, admin, "seed")
		require.NoError(t, res.Err)

		res = runJotCTL(t, ts, admin, "--json", "reset", "--yes")
		require.NoError(t, res.Err)

		var summary resetSummary
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &summary))
		assert.Equal(t, 3, summary.UsersDeleted)
	})
}
