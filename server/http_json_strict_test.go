package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The server decodes request bodies and encodes responses with
// encoding/json/v2 (see decodeJSONBody in internal/handlers/validation.go and
// wrapHandler in internal/server/server.go). These tests pin the two v2
// behaviors that differ from v1 on the wire.

// TestRejectDuplicateJSONKeys asserts that a request body carrying the same
// object member twice is rejected with 400 rather than silently taking the last
// value (the v1 last-write-wins behavior).
func TestRejectDuplicateJSONKeys(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "dupkeyuser", "password123", false)

	postRaw := func(t *testing.T, path, body string) int {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
			ts.HTTPServer.URL+path, bytes.NewReader([]byte(body)))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode
	}

	t.Run("duplicate key in note body is rejected", func(t *testing.T) {
		// Without the duplicate "content" this is a valid create; the duplicate is
		// the only reason it must fail.
		status := postRaw(t, "/api/v1/notes", `{"note_type":"text","content":"first","content":"second"}`)
		assert.Equal(t, http.StatusBadRequest, status)
	})

	t.Run("single key of the same note body still succeeds", func(t *testing.T) {
		status := postRaw(t, "/api/v1/notes", `{"note_type":"text","content":"only"}`)
		assert.Equal(t, http.StatusCreated, status)
	})

	t.Run("duplicate key in label body is rejected", func(t *testing.T) {
		status := postRaw(t, "/api/v1/labels", `{"name":"a","name":"b"}`)
		assert.Equal(t, http.StatusBadRequest, status)
	})
}

// TestNilSliceEncodesAsEmptyArray asserts that a note with no labels serializes
// its labels field as [] rather than null, matching the non-nullable Label[]
// declaration clients rely on (shared/src/types.ts). Under v1 a nil slice
// marshaled to null.
func TestNilSliceEncodesAsEmptyArray(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "labelshapeuser", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "body without labels",
	})
	require.NoError(t, err)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		ts.HTTPServer.URL+"/api/v1/notes/"+note.ID, nil)
	require.NoError(t, err)
	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &fields))
	labels, ok := fields["labels"]
	require.True(t, ok, "response is missing the labels field")
	assert.JSONEq(t, "[]", string(labels), "labels should encode as [] not null")
}
