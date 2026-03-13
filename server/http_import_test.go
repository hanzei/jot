package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// keepNoteJSON is a minimal valid Google Keep JSON payload.
type keepNoteJSON struct {
	Title       string `json:"title"`
	TextContent string `json:"textContent"`
	IsTrashed   bool   `json:"isTrashed"`
}

func marshalKeepNote(t *testing.T, kn keepNoteJSON) []byte {
	t.Helper()
	data, err := json.Marshal(kn)
	require.NoError(t, err)
	return data
}

// buildZip builds an in-memory ZIP archive containing the given files.
func buildZip(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, err := zw.Create(name)
		require.NoError(t, err)
		_, err = w.Write(data)
		require.NoError(t, err)
	}
	require.NoError(t, zw.Close())
	return buf.Bytes()
}

// doImportRequest posts a file via multipart to the import endpoint.
func doImportRequest(t *testing.T, ts *TestServer, user *TestUser, filename string, data []byte) *TestResponse {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = part.Write(data)
	require.NoError(t, err)
	require.NoError(t, mw.Close())

	req, err := http.NewRequest(http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := user.Client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	var body bytes.Buffer
	_, _ = body.ReadFrom(resp.Body)
	return &TestResponse{
		StatusCode: resp.StatusCode,
		Body:       body.Bytes(),
		Headers:    resp.Header,
		Cookies:    resp.Cookies(),
	}
}

func TestImportSingleJSONFile(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser1", "password123", false)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Imported Note", TextContent: "some content"})
	resp := doImportRequest(t, ts, user, "note.json", noteData)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var result map[string]any
	require.NoError(t, resp.UnmarshalBody(&result))
	assert.EqualValues(t, 1, result["imported"])
	assert.EqualValues(t, 0, result["skipped"])
}

func TestImportZIPWithMultipleFiles(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser2", "password123", false)

	note1 := marshalKeepNote(t, keepNoteJSON{Title: "Note One", TextContent: "content one"})
	note2 := marshalKeepNote(t, keepNoteJSON{Title: "Note Two", TextContent: "content two"})
	zipData := buildZip(t, map[string][]byte{
		"note1.json": note1,
		"note2.json": note2,
	})

	resp := doImportRequest(t, ts, user, "export.zip", zipData)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var result map[string]any
	require.NoError(t, resp.UnmarshalBody(&result))
	assert.EqualValues(t, 2, result["imported"])
}

func TestImportTrashedNoteSkipped(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser3", "password123", false)

	active := marshalKeepNote(t, keepNoteJSON{Title: "Keep Me", TextContent: "keep"})
	trashed := marshalKeepNote(t, keepNoteJSON{Title: "Bin Me", TextContent: "trash", IsTrashed: true})
	zipData := buildZip(t, map[string][]byte{
		"active.json":  active,
		"trashed.json": trashed,
	})

	resp := doImportRequest(t, ts, user, "export.zip", zipData)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var result map[string]any
	require.NoError(t, resp.UnmarshalBody(&result))
	assert.EqualValues(t, 1, result["imported"])
	assert.EqualValues(t, 1, result["skipped"])
}

func TestImportMissingFileFieldReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser4", "password123", false)

	// Send multipart body with no "file" field.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.Close())

	req, err := http.NewRequest(http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := user.Client.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportInvalidJSONReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser5", "password123", false)

	resp := doImportRequest(t, ts, user, "bad.json", []byte("not valid json"))
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportCorruptZIPReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser6", "password123", false)

	// ZIP magic bytes but corrupt content.
	corrupt := []byte{'P', 'K', 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF}
	resp := doImportRequest(t, ts, user, "bad.zip", corrupt)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Note", TextContent: "content"})

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", "note.json")
	require.NoError(t, err)
	_, err = part.Write(noteData)
	require.NoError(t, err)
	require.NoError(t, mw.Close())

	req, err := http.NewRequest(http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestImportNotesAppearInNotesList(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser7", "password123", false)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Findable Import", TextContent: "unique text"})
	resp := doImportRequest(t, ts, user, "note.json", noteData)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	listResp := ts.authRequest(t, user, http.MethodGet, "/api/v1/notes", nil)
	require.Equal(t, http.StatusOK, listResp.StatusCode)

	var notes []map[string]any
	require.NoError(t, listResp.UnmarshalBody(&notes))

	found := false
	for _, n := range notes {
		if n["title"] == "Findable Import" {
			found = true
			break
		}
	}
	assert.True(t, found, "imported note should appear in the notes list")
}
