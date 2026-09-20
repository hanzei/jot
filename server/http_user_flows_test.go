package main

import (
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReorderNotesEndpoint(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "reorder-user", "password123", false)
	other := ts.createTestUser(t, "reorder-other", "password123", false)

	createNote := func(t *testing.T, content string, owner *TestUser) string {
		t.Helper()
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: content,
		})
		require.NoError(t, err)
		return note.ID
	}

	note1 := createNote(t, "First", user)
	note2 := createNote(t, "Second", user)
	note3 := createNote(t, "Third", user)
	otherNote := createNote(t, "Other", other)

	t.Run("reorders notes and updates returned order", func(t *testing.T) {
		require.NoError(t, user.Client.ReorderNotes(t.Context(), []string{note3, note1, note2}))

		notes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		require.Len(t, notes, 3)

		assert.Equal(t, note3, notes[0].ID)
		assert.Equal(t, note1, notes[1].ID)
		assert.Equal(t, note2, notes[2].ID)
		assert.Equal(t, 0, notes[0].Position)
		assert.Equal(t, 1, notes[1].Position)
		assert.Equal(t, 2, notes[2].Position)
	})

	t.Run("empty note ID list returns 400", func(t *testing.T) {
		err := user.Client.ReorderNotes(t.Context(), []string{})
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("including note without access returns 403", func(t *testing.T) {
		beforeNotes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		require.Len(t, beforeNotes, 3)

		err = user.Client.ReorderNotes(t.Context(), []string{note1, otherNote})
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))

		afterNotes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		require.Len(t, afterNotes, 3)

		for i := range beforeNotes {
			assert.Equal(t, beforeNotes[i].ID, afterNotes[i].ID)
			assert.Equal(t, beforeNotes[i].Position, afterNotes[i].Position)
		}
	})
}

func TestRemoveLabelEndpoint(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "label-remove-user", "password123", false)
	other := ts.createTestUser(t, "label-remove-other", "password123", false)

	createNote := func(t *testing.T, content string) string {
		t.Helper()
		note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: content,
		})
		require.NoError(t, err)
		return note.ID
	}

	addLabel := func(t *testing.T, noteID, name string) string {
		t.Helper()
		labeled, err := user.Client.AddLabel(t.Context(), noteID, name)
		require.NoError(t, err)
		require.NotEmpty(t, labeled.Labels)
		for _, l := range labeled.Labels {
			if l.Name == name {
				return l.ID
			}
		}
		require.FailNow(t, "expected label not found on note", "name=%s", name)
		return ""
	}

	t.Run("removes label from note and unfilters from label query", func(t *testing.T) {
		noteID := createNote(t, "Labeled note")
		labelID := addLabel(t, noteID, "work")

		updated, err := user.Client.RemoveLabel(t.Context(), noteID, labelID)
		require.NoError(t, err)
		assert.Empty(t, updated.Labels)

		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Label: labelID})
		require.NoError(t, err)
		assert.Empty(t, notes)
	})

	t.Run("user without note access cannot remove label", func(t *testing.T) {
		noteID := createNote(t, "Restricted note")
		restrictedLabelID := addLabel(t, noteID, "restricted")

		_, err := other.Client.RemoveLabel(t.Context(), noteID, restrictedLabelID)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))

		note, err := user.Client.GetNote(t.Context(), noteID)
		require.NoError(t, err)
		require.Len(t, note.Labels, 1)
		assert.Equal(t, restrictedLabelID, note.Labels[0].ID)
	})
}

func TestAdminUpdateUserRoleEndpoint(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	t.Run("admin can promote user and promoted user gains admin access", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-promote", "password123", true)
		target := ts.createTestUser(t, "role-target-promote", "password123", false)

		_, err := target.Client.AdminListUsers(t.Context())
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))

		updated, err := admin.Client.AdminUpdateUserRole(t.Context(), target.User.ID, client.RoleAdmin)
		require.NoError(t, err)
		assert.Equal(t, client.RoleAdmin, updated.Role)

		_, err = target.Client.AdminListUsers(t.Context())
		require.NoError(t, err)
	})

	t.Run("non-admin cannot update roles", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-check", "password123", true)
		regular := ts.createTestUser(t, "role-regular-check", "password123", false)
		target := ts.createTestUser(t, "role-target-no-admin", "password123", false)

		_, err := target.Client.AdminListUsers(t.Context())
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))

		_, err = regular.Client.AdminUpdateUserRole(t.Context(), target.User.ID, client.RoleUser)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))

		users, err := admin.Client.AdminListUsers(t.Context())
		require.NoError(t, err)
		foundTarget := false
		for _, u := range users {
			if u.ID == target.User.ID {
				foundTarget = true
				assert.Equal(t, client.RoleUser, u.Role)
				break
			}
		}
		assert.True(t, foundTarget)
	})

	t.Run("invalid role returns 400", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-invalid", "password123", true)
		regular := ts.createTestUser(t, "role-regular-invalid", "password123", false)
		_, err := admin.Client.AdminUpdateUserRole(t.Context(), regular.User.ID, "super-admin")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("unknown user returns 404", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-unknown", "password123", true)
		_, err := admin.Client.AdminUpdateUserRole(t.Context(), "nonexistentid12345678", client.RoleUser)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

func TestAdminSetUserPasswordEndpoint(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	const oldPassword = "old-password-123"
	const newPassword = "new-password-456"

	t.Run("admin resets another user's password and invalidates their sessions", func(t *testing.T) {
		admin := ts.createTestUser(t, "pwreset-admin", "password123", true)
		target := ts.createTestUser(t, "pwreset-target", oldPassword, false)

		// The target starts with a live session.
		_, err := target.Client.Me(t.Context())
		require.NoError(t, err)

		err = admin.Client.AdminSetUserPassword(t.Context(), target.User.ID, newPassword)
		require.NoError(t, err)

		// The target's existing session is invalidated by the reset.
		_, err = target.Client.Me(t.Context())
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))

		// The old password no longer works.
		reject := ts.newClient()
		_, err = reject.Login(t.Context(), "pwreset-target", oldPassword)
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))

		// The new password works.
		accept := ts.newClient()
		_, err = accept.Login(t.Context(), "pwreset-target", newPassword)
		require.NoError(t, err)
	})

	t.Run("admin resetting own password keeps the current session authenticated", func(t *testing.T) {
		admin := ts.createTestUser(t, "pwreset-self-admin", oldPassword, true)

		err := admin.Client.AdminSetUserPassword(t.Context(), admin.User.ID, newPassword)
		require.NoError(t, err)

		// The request that performed the reset stays authenticated via a re-issued session.
		_, err = admin.Client.Me(t.Context())
		require.NoError(t, err)

		// A fresh login with the new password also succeeds.
		c := ts.newClient()
		_, err = c.Login(t.Context(), "pwreset-self-admin", newPassword)
		require.NoError(t, err)
	})

	t.Run("non-admin cannot set passwords", func(t *testing.T) {
		regular := ts.createTestUser(t, "pwreset-regular", "password123", false)
		target := ts.createTestUser(t, "pwreset-victim", oldPassword, false)

		err := regular.Client.AdminSetUserPassword(t.Context(), target.User.ID, newPassword)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))

		// The target's original password still works.
		c := ts.newClient()
		_, err = c.Login(t.Context(), "pwreset-victim", oldPassword)
		require.NoError(t, err)
	})

	t.Run("too-short password returns 400", func(t *testing.T) {
		admin := ts.createTestUser(t, "pwreset-admin-short", "password123", true)
		target := ts.createTestUser(t, "pwreset-target-short", oldPassword, false)

		err := admin.Client.AdminSetUserPassword(t.Context(), target.User.ID, "short")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("unknown user returns 404", func(t *testing.T) {
		admin := ts.createTestUser(t, "pwreset-admin-unknown", "password123", true)
		err := admin.Client.AdminSetUserPassword(t.Context(), "nonexistentid12345678", newPassword)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

func TestAdminUpdateUserRolePreventsDemotingLastAdmin(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "last-admin", "password123", true)

	_, err := admin.Client.AdminUpdateUserRole(t.Context(), admin.User.ID, client.RoleUser)
	assert.Equal(t, http.StatusConflict, client.StatusCode(err))

	me, err := admin.Client.Me(t.Context())
	require.NoError(t, err)
	assert.Equal(t, client.RoleAdmin, me.User.Role)
}
