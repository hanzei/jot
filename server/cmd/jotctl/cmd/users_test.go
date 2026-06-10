package cmd

import (
	"encoding/json"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsersListCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpass")
	ts.createUser(t, "alice", "alicepass")

	t.Run("table output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "list")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "admin")
		assert.Contains(t, res.Stdout, "alice")
		assert.Contains(t, res.Stdout, "ID")
		assert.Contains(t, res.Stdout, "USERNAME")
	})

	t.Run("json output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "--json", "users", "list")
		require.NoError(t, res.Err)

		var users []client.User
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &users))
		require.Len(t, users, 2)

		usernames := []string{users[0].Username, users[1].Username}
		assert.Contains(t, usernames, "admin")
		assert.Contains(t, usernames, "alice")
	})
}

func TestUsersCreateCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpass")

	t.Run("creates user with default role", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "create", "--username", "bob", "--password", "bobpass")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "bob")
		assert.Contains(t, res.Stdout, "Created user")

		// Verify via API that the user was created with the correct role.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		var bob *client.User
		for _, u := range users {
			if u.Username == "bob" {
				bob = u
				break
			}
		}
		require.NotNil(t, bob, "bob not found in user list")
		assert.Equal(t, client.RoleUser, bob.Role)
	})

	t.Run("creates admin user", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "create", "--username", "carol", "--password", "carolpass", "--role", "admin")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "carol")

		// Verify via API that carol was created as admin.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		var carol *client.User
		for _, u := range users {
			if u.Username == "carol" {
				carol = u
				break
			}
		}
		require.NotNil(t, carol, "carol not found in user list")
		assert.Equal(t, client.RoleAdmin, carol.Role)
	})

	t.Run("json output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "--json", "users", "create", "--username", "dave", "--password", "davepass")
		require.NoError(t, res.Err)

		var u client.User
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &u))
		assert.Equal(t, "dave", u.Username)
		assert.Equal(t, client.RoleUser, u.Role)
	})

	t.Run("rejects invalid role", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "users", "create", "--username", "eve", "--password", "evepass", "--role", "superuser")
		require.Error(t, res.Err)
		assert.Contains(t, res.Err.Error(), "invalid role")
	})
}

func TestUsersDeleteCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpass")

	t.Run("deletes existing user", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "todelete", "pass", client.RoleUser)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "users", "delete", u.ID)
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "Deleted user")

		// Verify via API that the user is gone.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		for _, listed := range users {
			assert.NotEqual(t, u.ID, listed.ID)
		}
	})
}

func TestUsersSetRoleCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpass")

	t.Run("promotes user to admin", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "promote", "pass", client.RoleUser)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "users", "set-role", u.ID, "admin")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "admin")

		// Verify via API that the role change took effect.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		var found *client.User
		for _, listed := range users {
			if listed.ID == u.ID {
				found = listed
				break
			}
		}
		require.NotNil(t, found, "promoted user not found in user list")
		assert.Equal(t, client.RoleAdmin, found.Role)
	})

	t.Run("demotes admin to user", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "demote", "pass", client.RoleAdmin)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "--json", "users", "set-role", u.ID, "user")
		require.NoError(t, res.Err)

		var updated client.User
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &updated))
		assert.Equal(t, client.RoleUser, updated.Role)

		// Verify via API that the role change took effect.
		users, err := admin.AdminListUsers(t.Context())
		require.NoError(t, err)
		var found *client.User
		for _, listed := range users {
			if listed.ID == u.ID {
				found = listed
				break
			}
		}
		require.NotNil(t, found, "demoted user not found in user list")
		assert.Equal(t, client.RoleUser, found.Role)
	})

	t.Run("rejects invalid role", func(t *testing.T) {
		u, err := admin.AdminCreateUser(t.Context(), "norole", "pass", client.RoleUser)
		require.NoError(t, err)

		res := runJotCTL(t, ts, admin, "users", "set-role", u.ID, "godmode")
		require.Error(t, res.Err)
		assert.Contains(t, res.Err.Error(), "invalid role")
	})
}
