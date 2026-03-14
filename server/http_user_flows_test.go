package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReorderNotesEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "reorder-user", "password123", false)
	other := ts.createTestUser(t, "reorder-other", "password123", false)

	createNote := func(t *testing.T, title string, owner *TestUser) string {
		resp := ts.authRequest(t, owner, http.MethodPost, "/api/v1/notes", map[string]any{
			"title":   title,
			"content": "content",
		})
		require.Equal(t, http.StatusCreated, resp.StatusCode)

		var note map[string]any
		require.NoError(t, resp.UnmarshalBody(&note))
		return note["id"].(string)
	}

	note1 := createNote(t, "First", user)
	note2 := createNote(t, "Second", user)
	note3 := createNote(t, "Third", user)
	otherNote := createNote(t, "Other", other)

	t.Run("reorders notes and updates returned order", func(t *testing.T) {
		reorderResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes/reorder", map[string]any{
			"note_ids": []string{note3, note1, note2},
		})
		require.Equal(t, http.StatusNoContent, reorderResp.StatusCode)

		listResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
		require.Equal(t, http.StatusOK, listResp.StatusCode)

		var notes []map[string]any
		require.NoError(t, listResp.UnmarshalBody(&notes))
		require.Len(t, notes, 3)

		assert.Equal(t, note3, notes[0]["id"])
		assert.Equal(t, note1, notes[1]["id"])
		assert.Equal(t, note2, notes[2]["id"])
		assert.Equal(t, 0, int(notes[0]["position"].(float64)))
		assert.Equal(t, 1, int(notes[1]["position"].(float64)))
		assert.Equal(t, 2, int(notes[2]["position"].(float64)))
	})

	t.Run("empty note ID list returns 400", func(t *testing.T) {
		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes/reorder", map[string]any{
			"note_ids": []string{},
		})
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, strings.ToLower(resp.GetString()), "empty note ids list")
	})

	t.Run("including note without access returns 403", func(t *testing.T) {
		beforeResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
		require.Equal(t, http.StatusOK, beforeResp.StatusCode)
		var beforeNotes []map[string]any
		require.NoError(t, beforeResp.UnmarshalBody(&beforeNotes))
		require.Len(t, beforeNotes, 3)

		resp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes/reorder", map[string]any{
			"note_ids": []string{note1, otherNote},
		})
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)

		afterResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
		require.Equal(t, http.StatusOK, afterResp.StatusCode)
		var afterNotes []map[string]any
		require.NoError(t, afterResp.UnmarshalBody(&afterNotes))
		require.Len(t, afterNotes, 3)

		for i := range beforeNotes {
			assert.Equal(t, beforeNotes[i]["id"], afterNotes[i]["id"])
			assert.Equal(t, int(beforeNotes[i]["position"].(float64)), int(afterNotes[i]["position"].(float64)))
		}
	})
}

func TestRemoveLabelEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "label-remove-user", "password123", false)
	other := ts.createTestUser(t, "label-remove-other", "password123", false)

	createNote := func(t *testing.T, title string) string {
		createResp := ts.authRequest(t, user, http.MethodPost, "/api/v1/notes", map[string]any{
			"title":   title,
			"content": "content",
		})
		require.Equal(t, http.StatusCreated, createResp.StatusCode)

		var created map[string]any
		require.NoError(t, createResp.UnmarshalBody(&created))
		return created["id"].(string)
	}

	addLabel := func(t *testing.T, noteID string, name string) string {
		addResp := ts.authRequest(t, user, http.MethodPost, fmt.Sprintf("/api/v1/notes/%s/labels", noteID), map[string]any{
			"name": name,
		})
		require.Equal(t, http.StatusOK, addResp.StatusCode)

		var labeledNote map[string]any
		require.NoError(t, addResp.UnmarshalBody(&labeledNote))
		labels := labeledNote["labels"].([]any)
		require.NotEmpty(t, labels)
		for _, label := range labels {
			labelMap := label.(map[string]any)
			if labelMap["name"] == name {
				return labelMap["id"].(string)
			}
		}
		require.FailNow(t, "expected label not found on note", "name=%s", name)
		return ""
	}

	t.Run("removes label from note and unfilters from label query", func(t *testing.T) {
		noteID := createNote(t, "Labeled note")
		labelID := addLabel(t, noteID, "work")

		removeResp := ts.authRequest(t, user, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/labels/%s", noteID, labelID), nil)
		require.Equal(t, http.StatusOK, removeResp.StatusCode)

		var updated map[string]any
		require.NoError(t, removeResp.UnmarshalBody(&updated))
		require.Empty(t, updated["labels"].([]any))

		filterResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes?label=%s", labelID), nil)
		require.Equal(t, http.StatusOK, filterResp.StatusCode)

		var filtered []map[string]any
		require.NoError(t, filterResp.UnmarshalBody(&filtered))
		assert.Empty(t, filtered)
	})

	t.Run("user without note access cannot remove label", func(t *testing.T) {
		noteID := createNote(t, "Restricted note")
		restrictedLabelID := addLabel(t, noteID, "restricted")

		otherResp := ts.authRequest(t, other, http.MethodDelete, fmt.Sprintf("/api/v1/notes/%s/labels/%s", noteID, restrictedLabelID), nil)
		assert.Equal(t, http.StatusForbidden, otherResp.StatusCode)

		ownerResp := ts.authRequest(t, user, http.MethodGet, fmt.Sprintf("/api/v1/notes/%s", noteID), nil)
		require.Equal(t, http.StatusOK, ownerResp.StatusCode)

		var note map[string]any
		require.NoError(t, ownerResp.UnmarshalBody(&note))
		currentLabels := note["labels"].([]any)
		require.Len(t, currentLabels, 1)
		assert.Equal(t, restrictedLabelID, currentLabels[0].(map[string]any)["id"])
	})
}

func TestAdminUpdateUserRoleEndpoint(t *testing.T) {
	ts := setupTestServer(t)

	t.Run("admin can promote user and promoted user gains admin access", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-promote", "password123", true)
		target := ts.createTestUser(t, "role-target-promote", "password123", false)

		// Baseline: target user is not admin yet.
		prePromotionResp := ts.authRequest(t, target, http.MethodGet, "/api/v1/admin/users", nil)
		assert.Equal(t, http.StatusForbidden, prePromotionResp.StatusCode)

		resp := ts.authRequest(t, admin, http.MethodPut, fmt.Sprintf("/api/v1/admin/users/%s/role", target.User.ID), map[string]any{
			"role": "admin",
		})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		var updated map[string]any
		require.NoError(t, resp.UnmarshalBody(&updated))
		assert.Equal(t, "admin", updated["role"])

		adminListResp := ts.authRequest(t, target, http.MethodGet, "/api/v1/admin/users", nil)
		assert.Equal(t, http.StatusOK, adminListResp.StatusCode)
	})

	t.Run("non-admin cannot update roles", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-check", "password123", true)
		regular := ts.createTestUser(t, "role-regular-check", "password123", false)
		target := ts.createTestUser(t, "role-target-no-admin", "password123", false)

		// Baseline: target user cannot access admin listing.
		preUpdateResp := ts.authRequest(t, target, http.MethodGet, "/api/v1/admin/users", nil)
		assert.Equal(t, http.StatusForbidden, preUpdateResp.StatusCode)

		resp := ts.authRequest(t, regular, http.MethodPut, fmt.Sprintf("/api/v1/admin/users/%s/role", target.User.ID), map[string]any{
			"role": "user",
		})
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)

		adminListResp := ts.authRequest(t, admin, http.MethodGet, "/api/v1/admin/users", nil)
		require.Equal(t, http.StatusOK, adminListResp.StatusCode)
		var payload map[string]any
		require.NoError(t, adminListResp.UnmarshalBody(&payload))
		users := payload["users"].([]any)

		foundTarget := false
		for _, u := range users {
			userMap := u.(map[string]any)
			if userMap["id"] == target.User.ID {
				foundTarget = true
				assert.Equal(t, "user", userMap["role"])
				break
			}
		}
		assert.True(t, foundTarget)
	})

	t.Run("invalid role returns 400", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-invalid", "password123", true)
		regular := ts.createTestUser(t, "role-regular-invalid", "password123", false)
		resp := ts.authRequest(t, admin, http.MethodPut, fmt.Sprintf("/api/v1/admin/users/%s/role", regular.User.ID), map[string]any{
			"role": "super-admin",
		})
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		assert.Contains(t, strings.ToLower(resp.GetString()), "invalid role")
	})

	t.Run("unknown user returns 404", func(t *testing.T) {
		admin := ts.createTestUser(t, "role-admin-unknown", "password123", true)
		resp := ts.authRequest(t, admin, http.MethodPut, "/api/v1/admin/users/nonexistentid12345678/role", map[string]any{
			"role": "user",
		})
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})
}

func TestAdminUpdateUserRolePreventsDemotingLastAdmin(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "last-admin", "password123", true)

	resp := ts.authRequest(t, admin, http.MethodPut, fmt.Sprintf("/api/v1/admin/users/%s/role", admin.User.ID), map[string]any{
		"role": "user",
	})
	assert.Equal(t, http.StatusConflict, resp.StatusCode)

	meResp := ts.authRequest(t, admin, http.MethodGet, "/api/v1/me", nil)
	require.Equal(t, http.StatusOK, meResp.StatusCode)
	var me map[string]any
	require.NoError(t, meResp.UnmarshalBody(&me))
	userData := me["user"].(map[string]any)
	assert.Equal(t, "admin", userData["role"])
}
