package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
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

func TestImportSingleJSONFile(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser1", "password123", false)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Imported Note", TextContent: "some content"})
	result, err := user.Client.ImportNotes(t.Context(), "note.json", bytes.NewReader(noteData))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 0, result.Skipped)
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

	result, err := user.Client.ImportNotes(t.Context(), "export.zip", bytes.NewReader(zipData))
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
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

	result, err := user.Client.ImportNotes(t.Context(), "export.zip", bytes.NewReader(zipData))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 1, result.Skipped)
}

func TestImportMissingFileFieldReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser4", "password123", false)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.Close())

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportInvalidJSONReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser5", "password123", false)

	_, err := user.Client.ImportNotes(t.Context(), "bad.json", bytes.NewReader([]byte("not valid json")))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportCorruptZIPReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser6", "password123", false)

	corrupt := []byte{'P', 'K', 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF}
	_, err := user.Client.ImportNotes(t.Context(), "bad.zip", bytes.NewReader(corrupt))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
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

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
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
	_, err := user.Client.ImportNotes(t.Context(), "note.json", bytes.NewReader(noteData))
	require.NoError(t, err)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)

	found := false
	for _, n := range notes {
		if n.Title == "Findable Import" {
			found = true
			break
		}
	}
	assert.True(t, found, "imported note should appear in the notes list")
}
