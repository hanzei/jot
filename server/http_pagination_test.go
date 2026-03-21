package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func noteIDs(notes []client.Note) []string {
	ids := make([]string, len(notes))
	for i, note := range notes {
		ids[i] = note.ID
	}
	return ids
}

func userInfoIDs(users []client.UserInfo) []string {
	ids := make([]string, len(users))
	for i, user := range users {
		ids[i] = user.ID
	}
	return ids
}

func userIDs(users []*client.User) []string {
	ids := make([]string, len(users))
	for i, user := range users {
		ids[i] = user.ID
	}
	return ids
}

func pagedUserIDs(users []client.User) []string {
	ids := make([]string, len(users))
	for i, user := range users {
		ids[i] = user.ID
	}
	return ids
}

func sessionInfoIDs(sessions []client.SessionInfo) []string {
	ids := make([]string, len(sessions))
	for i, session := range sessions {
		ids[i] = session.ID
	}
	return ids
}

func sortedStringsAsc(values []string) []string {
	sorted := append([]string(nil), values...)
	sort.Strings(sorted)
	return sorted
}

func sortedStringsDesc(values []string) []string {
	sorted := append([]string(nil), values...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] > sorted[j]
	})
	return sorted
}

func requireStatusCode(t *testing.T, c *client.Client, url string) int {
	t.Helper()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)

	resp, err := c.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	return resp.StatusCode
}

func hashedSessionID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])[:22]
}

func TestNotesPagination(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "notespager", "password123", false)

	createdIDs := make([]string, 0, 3)
	for _, title := range []string{"first", "second", "third"} {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
			Title:   title,
			Content: "content",
		})
		require.NoError(t, err)
		createdIDs = append(createdIDs, note.ID)
	}

	_, err := ts.Server.GetDB().Exec(`UPDATE notes SET position = 0 WHERE user_id = ?`, user.User.ID)
	require.NoError(t, err)

	expectedIDs := sortedStringsAsc(createdIDs)

	firstPage, err := user.Client.ListNotesPage(t.Context(), &client.ListNotesOptions{Limit: 2})
	require.NoError(t, err)
	require.Len(t, firstPage.Items, 2)
	assert.Equal(t, expectedIDs[:2], noteIDs(firstPage.Items))
	assert.Equal(t, 2, firstPage.Pagination.Limit)
	assert.Equal(t, 0, firstPage.Pagination.Offset)
	assert.Equal(t, 2, firstPage.Pagination.Returned)
	assert.True(t, firstPage.Pagination.HasMore)
	require.NotNil(t, firstPage.Pagination.NextOffset)
	assert.Equal(t, 2, *firstPage.Pagination.NextOffset)

	secondPage, err := user.Client.ListNotesPage(t.Context(), &client.ListNotesOptions{
		Limit:  2,
		Offset: *firstPage.Pagination.NextOffset,
	})
	require.NoError(t, err)
	require.Len(t, secondPage.Items, 1)
	assert.Equal(t, expectedIDs[2:], noteIDs(secondPage.Items))
	assert.Equal(t, 1, secondPage.Pagination.Returned)
	assert.False(t, secondPage.Pagination.HasMore)
	assert.Nil(t, secondPage.Pagination.NextOffset)

	allNotes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	assert.Equal(t, expectedIDs, noteIDs(allNotes))
}

func TestUsersPagination(t *testing.T) {
	ts := setupTestServer(t)
	viewer := ts.createTestUser(t, "viewer", "password123", false)
	otherUsers := []*TestUser{
		ts.createTestUser(t, "alpha", "password123", false),
		ts.createTestUser(t, "beta", "password123", false),
		ts.createTestUser(t, "gamma", "password123", false),
	}

	_, err := ts.Server.GetDB().Exec(`UPDATE users SET created_at = '2024-01-01 00:00:00'`)
	require.NoError(t, err)

	expectedIDs := sortedStringsDesc([]string{
		otherUsers[0].User.ID,
		otherUsers[1].User.ID,
		otherUsers[2].User.ID,
	})

	firstPage, err := viewer.Client.SearchUsersPage(t.Context(), "", &client.PaginationOptions{Limit: 2})
	require.NoError(t, err)
	require.Len(t, firstPage.Items, 2)
	assert.Equal(t, expectedIDs[:2], userInfoIDs(firstPage.Items))
	assert.True(t, firstPage.Pagination.HasMore)
	require.NotNil(t, firstPage.Pagination.NextOffset)
	assert.Equal(t, 2, *firstPage.Pagination.NextOffset)

	secondPage, err := viewer.Client.SearchUsersPage(t.Context(), "", &client.PaginationOptions{
		Limit:  2,
		Offset: *firstPage.Pagination.NextOffset,
	})
	require.NoError(t, err)
	require.Len(t, secondPage.Items, 1)
	assert.Equal(t, expectedIDs[2:], userInfoIDs(secondPage.Items))
	assert.False(t, secondPage.Pagination.HasMore)
	assert.Nil(t, secondPage.Pagination.NextOffset)

	allUsers, err := viewer.Client.SearchUsers(t.Context(), "")
	require.NoError(t, err)
	assert.Equal(t, expectedIDs, userInfoIDs(allUsers))
}

func TestAdminUsersPagination(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "adminpager", "password123", true)
	memberA := ts.createTestUser(t, "membera", "password123", false)
	memberB := ts.createTestUser(t, "memberb", "password123", false)
	memberC := ts.createTestUser(t, "memberc", "password123", false)

	_, err := ts.Server.GetDB().Exec(`UPDATE users SET created_at = '2024-01-01 00:00:00'`)
	require.NoError(t, err)

	expectedIDs := sortedStringsDesc([]string{
		admin.User.ID,
		memberA.User.ID,
		memberB.User.ID,
		memberC.User.ID,
	})

	firstPage, err := admin.Client.AdminListUsersPage(t.Context(), &client.PaginationOptions{Limit: 2})
	require.NoError(t, err)
	require.Len(t, firstPage.Items, 2)
	assert.Equal(t, expectedIDs[:2], pagedUserIDs(firstPage.Items))
	assert.True(t, firstPage.Pagination.HasMore)
	require.NotNil(t, firstPage.Pagination.NextOffset)

	secondPage, err := admin.Client.AdminListUsersPage(t.Context(), &client.PaginationOptions{
		Limit:  2,
		Offset: *firstPage.Pagination.NextOffset,
	})
	require.NoError(t, err)
	require.Len(t, secondPage.Items, 2)
	assert.Equal(t, expectedIDs[2:], pagedUserIDs(secondPage.Items))
	assert.False(t, secondPage.Pagination.HasMore)
	assert.Nil(t, secondPage.Pagination.NextOffset)

	allUsers, err := admin.Client.AdminListUsers(t.Context())
	require.NoError(t, err)
	assert.Equal(t, expectedIDs, userIDs(allUsers))
}

func TestSessionsPagination(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "sessionpager", "password123", false)

	for range 3 {
		c := ts.newClient()
		_, err := c.Login(t.Context(), "sessionpager", "password123")
		require.NoError(t, err)
	}

	_, err := ts.Server.GetDB().Exec(`UPDATE sessions SET created_at = '2024-01-01 00:00:00' WHERE user_id = ?`, user.User.ID)
	require.NoError(t, err)

	rows, err := ts.Server.GetDB().QueryContext(context.Background(), `SELECT token FROM sessions WHERE user_id = ? ORDER BY token DESC`, user.User.ID)
	require.NoError(t, err)
	defer func() {
		require.NoError(t, rows.Close())
	}()

	expectedIDs := make([]string, 0, 4)
	for rows.Next() {
		var token string
		require.NoError(t, rows.Scan(&token))
		expectedIDs = append(expectedIDs, hashedSessionID(token))
	}
	require.NoError(t, rows.Err())
	require.Len(t, expectedIDs, 4)

	firstPage, err := user.Client.ListSessionsPage(t.Context(), &client.PaginationOptions{Limit: 2})
	require.NoError(t, err)
	require.Len(t, firstPage.Items, 2)
	assert.Equal(t, expectedIDs[:2], sessionInfoIDs(firstPage.Items))
	assert.True(t, firstPage.Pagination.HasMore)
	require.NotNil(t, firstPage.Pagination.NextOffset)

	secondPage, err := user.Client.ListSessionsPage(t.Context(), &client.PaginationOptions{
		Limit:  2,
		Offset: *firstPage.Pagination.NextOffset,
	})
	require.NoError(t, err)
	require.Len(t, secondPage.Items, 2)
	assert.Equal(t, expectedIDs[2:], sessionInfoIDs(secondPage.Items))
	assert.False(t, secondPage.Pagination.HasMore)
	assert.Nil(t, secondPage.Pagination.NextOffset)

	allSessions, err := user.Client.ListSessions(t.Context())
	require.NoError(t, err)
	assert.Equal(t, expectedIDs, sessionInfoIDs(allSessions))
}

func TestPaginationValidation(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "validator", "password123", false)
	admin := ts.createTestUser(t, "validatoradmin", "password123", true)

	testCases := []struct {
		name string
		c    *client.Client
		path string
	}{
		{
			name: "notes",
			c:    user.Client,
			path: "/api/v1/notes",
		},
		{
			name: "users",
			c:    user.Client,
			path: "/api/v1/users",
		},
		{
			name: "admin users",
			c:    admin.Client,
			path: "/api/v1/admin/users",
		},
		{
			name: "sessions",
			c:    user.Client,
			path: "/api/v1/sessions",
		},
	}

	invalidQueries := []string{
		"limit=0",
		"limit=101",
		"limit=abc",
		"offset=-1",
		"offset=abc",
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			status := requireStatusCode(t, tc.c, ts.HTTPServer.URL+tc.path+"?limit=100")
			assert.Equal(t, http.StatusOK, status)

			for _, query := range invalidQueries {
				status := requireStatusCode(t, tc.c, ts.HTTPServer.URL+tc.path+"?"+query)
				assert.Equal(t, http.StatusBadRequest, status, query)
			}
		})
	}
}
