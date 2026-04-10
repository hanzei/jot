package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// keepNoteJSON is a minimal valid Google Keep JSON payload.
type keepNoteJSON struct {
	Title       string             `json:"title"`
	TextContent string             `json:"textContent"`
	ListContent []keepNoteItemJSON `json:"listContent,omitempty"`
	IsTrashed   bool               `json:"isTrashed"`
	IsPinned    bool               `json:"isPinned"`
	IsArchived  bool               `json:"isArchived"`
}

type keepNoteItemJSON struct {
	Text      string `json:"text"`
	IsChecked bool   `json:"isChecked"`
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
	result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(noteData))
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

	result, err := user.Client.ImportNotes(t.Context(), "google_keep", "export.zip", bytes.NewReader(zipData))
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

	result, err := user.Client.ImportNotes(t.Context(), "google_keep", "export.zip", bytes.NewReader(zipData))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 1, result.Skipped)
}

func TestImportMissingFileFieldReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser4", "password123", false)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("import_type", "google_keep"))
	require.NoError(t, mw.Close())

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportMissingImportTypeReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser4b", "password123", false)

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

	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportInvalidImportTypeReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser4c", "password123", false)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Note", TextContent: "content"})
	_, err := user.Client.ImportNotes(t.Context(), "unknown_format", "note.json", bytes.NewReader(noteData))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportInvalidJSONReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser5", "password123", false)

	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "bad.json", bytes.NewReader([]byte("not valid json")))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportCorruptZIPReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser6", "password123", false)

	corrupt := []byte{'P', 'K', 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF}
	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "bad.zip", bytes.NewReader(corrupt))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Note", TextContent: "content"})

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("import_type", "google_keep"))
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
	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(noteData))
	require.NoError(t, err)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)

	found := false
	for _, n := range notes {
		if n.Content == "# Findable Import\n\nunique text" {
			found = true
			break
		}
	}
	assert.True(t, found, "imported note should appear in the notes list")
}

func TestImportPinnedAndArchivedNote(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importpinuser", "password123", false)

	t.Run("pinned note is imported as pinned", func(t *testing.T) {
		// Title-only Keep notes are stored as "# Title" (H1 heading) in content.
		data := marshalKeepNote(t, keepNoteJSON{Title: "Pinned Import", IsPinned: true})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)

		notes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		var found bool
		for _, n := range notes {
			if n.Content == "# Pinned Import" {
				found = true
				assert.True(t, n.Pinned)
				break
			}
		}
		assert.True(t, found)
	})

	t.Run("archived note is imported as archived", func(t *testing.T) {
		// Title-only Keep notes are stored as "# Title" (H1 heading) in content.
		data := marshalKeepNote(t, keepNoteJSON{Title: "Archived Import", IsArchived: true})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)

		notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
		require.NoError(t, err)
		var found bool
		for _, n := range notes {
			if n.Content == "# Archived Import" {
				found = true
				assert.True(t, n.Archived)
				break
			}
		}
		assert.True(t, found)
	})
}

func TestImportValidation(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importvaluser", "password123", false)

	t.Run("title exceeding max is skipped with error", func(t *testing.T) {
		data := marshalKeepNote(t, keepNoteJSON{Title: strings.Repeat("a", 201)})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 0, result.Imported)
		assert.Len(t, result.Errors, 1)
	})

	t.Run("content exceeding max is skipped with error", func(t *testing.T) {
		data := marshalKeepNote(t, keepNoteJSON{TextContent: strings.Repeat("a", 10001)})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 0, result.Imported)
		assert.Len(t, result.Errors, 1)
	})

	t.Run("too many items is skipped with error", func(t *testing.T) {
		items := make([]keepNoteItemJSON, 501)
		for i := range items {
			items[i] = keepNoteItemJSON{Text: "item"}
		}
		data := marshalKeepNote(t, keepNoteJSON{Title: "Many Items", ListContent: items})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 0, result.Imported)
		assert.Len(t, result.Errors, 1)
	})

	t.Run("item text exceeding max is skipped with error", func(t *testing.T) {
		data := marshalKeepNote(t, keepNoteJSON{
			Title:       "List Note",
			ListContent: []keepNoteItemJSON{{Text: strings.Repeat("a", 501)}},
		})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 0, result.Imported)
		assert.Len(t, result.Errors, 1)
	})

	t.Run("valid note alongside invalid note imports only the valid one", func(t *testing.T) {
		valid := marshalKeepNote(t, keepNoteJSON{Title: "Good Note", TextContent: "ok"})
		invalid := marshalKeepNote(t, keepNoteJSON{Title: strings.Repeat("x", 201)})
		zipData := buildZip(t, map[string][]byte{
			"valid.json":   valid,
			"invalid.json": invalid,
		})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "export.zip", bytes.NewReader(zipData))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		assert.Len(t, result.Errors, 1)
	})
}
