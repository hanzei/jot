package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestCreateNoteIdempotency covers the client-supplied note ID path that makes
// an offline-created note's replayed POST /notes idempotent (issue #475).
func TestCreateNoteIdempotency(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "idempotencyuser", "password123", false)

	// postNoteRaw sends a raw JSON body to POST /api/v1/notes and returns the
	// status code plus decoded response, so tests can supply an arbitrary `id`
	// (not expressible via the typed client) and inspect the created note.
	postNoteRaw := func(t *testing.T, body map[string]any) (int, *client.Note) {
		t.Helper()
		data, err := json.Marshal(body)
		require.NoError(t, err)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
			ts.HTTPServer.URL+"/api/v1/notes", bytes.NewReader(data))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			return resp.StatusCode, nil
		}
		var note client.Note
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&note))
		return resp.StatusCode, &note
	}

	t.Run("client-supplied id is honored", func(t *testing.T) {
		id := "AbcdefghijklmnopqrstUv" // 22-char valid ID
		status, note := postNoteRaw(t, map[string]any{
			"id":        id,
			"note_type": "text",
			"content":   "honored id",
		})
		require.Equal(t, http.StatusCreated, status)
		require.NotNil(t, note)
		assert.Equal(t, id, note.ID)

		fetched, err := user.Client.GetNote(t.Context(), id)
		require.NoError(t, err)
		assert.Equal(t, id, fetched.ID)
	})

	t.Run("replaying a create with the same id returns 409 and does not duplicate", func(t *testing.T) {
		id := "Replay00000000000000Ab"
		status, note := postNoteRaw(t, map[string]any{
			"id":        id,
			"note_type": "text",
			"content":   "first write",
		})
		require.Equal(t, http.StatusCreated, status)
		require.NotNil(t, note)

		// Replay the identical create: the original already committed, so the
		// server must reject the duplicate rather than insert a second note.
		replayStatus, _ := postNoteRaw(t, map[string]any{
			"id":        id,
			"note_type": "text",
			"content":   "first write",
		})
		assert.Equal(t, http.StatusConflict, replayStatus)

		notes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		matches := 0
		for _, n := range notes {
			if n.ID == id {
				matches++
			}
		}
		assert.Equal(t, 1, matches, "expected exactly one note with the replayed id")
	})

	t.Run("invalid id format returns 400", func(t *testing.T) {
		status, _ := postNoteRaw(t, map[string]any{
			"id":        "too-short",
			"note_type": "text",
			"content":   "bad id",
		})
		assert.Equal(t, http.StatusBadRequest, status)
	})

	t.Run("omitting id falls back to a server-generated id", func(t *testing.T) {
		status, note := postNoteRaw(t, map[string]any{
			"note_type": "text",
			"content":   "server generated",
		})
		require.Equal(t, http.StatusCreated, status)
		require.NotNil(t, note)
		assert.NotEmpty(t, note.ID)
	})

	t.Run("same id may be reused across different users", func(t *testing.T) {
		other := ts.createTestUser(t, "idempotencyuser2", "password123", false)
		id := "CrossUser00000000000Ab"

		status, note := postNoteRaw(t, map[string]any{
			"id":        id,
			"note_type": "text",
			"content":   "owner one",
		})
		require.Equal(t, http.StatusCreated, status)
		require.NotNil(t, note)

		// A different user's PRIMARY-KEY-global ID collision is still rejected,
		// documenting that note IDs share one namespace across users.
		data, err := json.Marshal(map[string]any{
			"id":        id,
			"note_type": "text",
			"content":   "owner two",
		})
		require.NoError(t, err)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
			ts.HTTPServer.URL+"/api/v1/notes", bytes.NewReader(data))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := other.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		assert.Equal(t, http.StatusConflict, resp.StatusCode)
	})
}
