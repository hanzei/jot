package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser1", "password123", false)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Imported Note", TextContent: "some content"})
	result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(noteData))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 0, result.Skipped)
}

func TestImportZIPWithMultipleFiles(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser4c", "password123", false)

	noteData := marshalKeepNote(t, keepNoteJSON{Title: "Note", TextContent: "content"})
	_, err := user.Client.ImportNotes(t.Context(), "unknown_format", "note.json", bytes.NewReader(noteData))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportInvalidJSONReturns400(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser5", "password123", false)

	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "bad.json", bytes.NewReader([]byte("not valid json")))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportCorruptZIPReturns400(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser6", "password123", false)

	corrupt := []byte{'P', 'K', 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF}
	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "bad.zip", bytes.NewReader(corrupt))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportUnauthenticatedReturns401(t *testing.T) {
	t.Parallel()
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

	resp, err := ts.HTTPServer.Client().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestImportNotesAppearInNotesList(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

// --- usememos import tests ---

const (
	usememosTestPath = "/api/v1/memos"
	usememosTestAuth = "Bearer testtoken"
	stateActive      = "NORMAL"
	stateArchived    = "ARCHIVED"
)

// usememosPage holds the memos and optional pagination token for a mock page.
type usememosPage struct {
	memos         []map[string]any
	nextPageToken string
}

// buildUsememosServer starts an httptest.Server that serves pages of mock usememos
// API responses at GET /api/v1/memos. The pages slice is served in order, filtered
// by the request's `state` query parameter — only memos whose `state` field matches
// the requested state are returned (this mirrors the real Memos v1 API, which only
// returns NORMAL memos by default and requires a separate ?state=ARCHIVED pass for
// archived memos). Pagination state is tracked independently per state. Requests
// must carry "Authorization: Bearer testtoken" and a `state` query parameter.
func buildUsememosServer(t *testing.T, pages []usememosPage) *httptest.Server {
	t.Helper()
	pageIdxByState := map[string]int{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != usememosTestPath {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != usememosTestAuth {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		state := r.URL.Query().Get("state")
		if state == "" {
			http.Error(w, "missing state", http.StatusBadRequest)
			assert.Fail(t, "request missing state query param")
			return
		}
		pageIdx := pageIdxByState[state]
		// Validate the incoming pageToken: first request for a state must have none;
		// subsequent requests must echo the nextPageToken from the previous response
		// for the same state.
		gotToken := r.URL.Query().Get("pageToken")
		var wantToken string
		if pageIdx > 0 {
			wantToken = pages[pageIdx-1].nextPageToken
		}
		if gotToken != wantToken {
			http.Error(w, "unexpected pageToken", http.StatusBadRequest)
			assert.Failf(t, "unexpected pageToken", "state=%s got %q, want %q", state, gotToken, wantToken)
			return
		}
		if pageIdx >= len(pages) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"memos":[]}`))
			return
		}
		p := pages[pageIdx]
		pageIdxByState[state] = pageIdx + 1
		filtered := filterMemosByState(p.memos, state)
		resp := map[string]any{
			"memos":         filtered,
			"nextPageToken": p.nextPageToken,
		}
		w.Header().Set("Content-Type", "application/json")
		assert.NoError(t, json.NewEncoder(w).Encode(resp))
	}))
}

// filterMemosByState returns only memos whose "state" field equals state.
// Memos with no state field default to NORMAL.
func filterMemosByState(memos []map[string]any, state string) []map[string]any {
	out := make([]map[string]any, 0, len(memos))
	for _, m := range memos {
		ms, _ := m["state"].(string)
		if ms == "" {
			ms = stateActive
		}
		if ms == state {
			out = append(out, m)
		}
	}
	return out
}

func TestImportUsememosHappyPath(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser1", "password123", false)

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Hello world", "pinned": false},
		{"name": "memos/2", "state": "NORMAL", "content": "Second memo", "pinned": false},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
	assert.Equal(t, 0, result.Skipped)
	assert.Empty(t, result.Errors)
}

func TestImportUsememosDeletedSkipped(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser2", "password123", false)

	// The Memos v1 API only returns NORMAL or ARCHIVED memos in response to
	// ?state=NORMAL / ?state=ARCHIVED queries (which is all the importer issues),
	// so DELETED memos are filtered server-side and never reach the importer.
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Keep me"},
		{"name": "memos/2", "state": "DELETED", "content": "Delete me"},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 0, result.Skipped)
}

func TestImportUsememosArchivedImportedAsArchived(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser3", "password123", false)

	memos := []map[string]any{
		{"name": "memos/1", "state": "ARCHIVED", "content": "Archived memo"},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
	require.NoError(t, err)
	require.Len(t, notes, 1, "expected exactly one archived note")
	assert.Equal(t, "Archived memo", notes[0].Content)
	assert.True(t, notes[0].Archived)
}

func TestImportUsememosPinnedImportedAsPinned(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser4", "password123", false)

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Pinned memo", "pinned": true},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1, "expected exactly one note")
	assert.Equal(t, "Pinned memo", notes[0].Content)
	assert.True(t, notes[0].Pinned)
}

func TestImportUsememosTagsExtractedAndStripped(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser5", "password123", false)

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "My note #golang #testing"},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)

	assert.NotContains(t, notes[0].Content, "#golang")
	assert.NotContains(t, notes[0].Content, "#testing")

	labelNames := make([]string, 0, len(notes[0].Labels))
	for _, l := range notes[0].Labels {
		labelNames = append(labelNames, l.Name)
	}
	assert.ElementsMatch(t, []string{"golang", "testing"}, labelNames)
}

func TestImportUsememosTagsInCodeFenceNotExtracted(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser6", "password123", false)

	content := "Before\n```\n#notag\n```\nAfter #realtag"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)

	assert.Contains(t, notes[0].Content, "#notag")
	assert.NotContains(t, notes[0].Content, "#realtag")

	labelNames := make([]string, 0, len(notes[0].Labels))
	for _, l := range notes[0].Labels {
		labelNames = append(labelNames, l.Name)
	}
	assert.Equal(t, []string{"realtag"}, labelNames)
}

func TestImportUsememosChecklistImportedAsListNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememoschecklist1", "password123", false)

	content := "- [ ] buy milk\n- [x] walk the dog\n  - [ ] feed the cat"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Empty(t, result.Errors)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, client.NoteTypeList, notes[0].NoteType)
	assert.Empty(t, notes[0].Content)

	note, err := user.Client.GetNote(t.Context(), notes[0].ID)
	require.NoError(t, err)
	require.Len(t, note.Items, 3)

	assert.Equal(t, "buy milk", note.Items[0].Text)
	assert.False(t, note.Items[0].Completed)
	assert.Nil(t, note.Items[0].ParentID)

	assert.Equal(t, "walk the dog", note.Items[1].Text)
	assert.True(t, note.Items[1].Completed)
	assert.Nil(t, note.Items[1].ParentID)

	assert.Equal(t, "feed the cat", note.Items[2].Text)
	assert.False(t, note.Items[2].Completed)
	// Imported at indent level 1, so nested under the preceding top-level item.
	require.NotNil(t, note.Items[2].ParentID)
	assert.Equal(t, note.Items[1].ID, *note.Items[2].ParentID)
}

func TestImportUsememosTitledChecklistImportedAsListNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememoschecklist4", "password123", false)

	// A heading on the first line followed by a checklist becomes a titled list
	// note: the heading is the note title and the remaining lines are items.
	content := "# Groceries\n- [ ] buy milk\n- [x] walk the dog"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, client.NoteTypeList, notes[0].NoteType)
	assert.Equal(t, "Groceries", notes[0].Title)
	assert.Empty(t, notes[0].Content)

	note, err := user.Client.GetNote(t.Context(), notes[0].ID)
	require.NoError(t, err)
	require.Len(t, note.Items, 2)
	assert.Equal(t, "buy milk", note.Items[0].Text)
	assert.False(t, note.Items[0].Completed)
	assert.Equal(t, "walk the dog", note.Items[1].Text)
	assert.True(t, note.Items[1].Completed)
}

func TestImportUsememosHeadingOnlyStaysTextNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememoschecklist5", "password123", false)

	// A heading with non-checklist body is not a todo list and must stay a text
	// note that preserves the full Markdown content.
	content := "# Journal\nToday I learned a lot."
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, client.NoteTypeText, notes[0].NoteType)
	assert.Empty(t, notes[0].Title)
	assert.Equal(t, content, notes[0].Content)
}

func TestImportUsememosMixedContentStaysTextNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememoschecklist2", "password123", false)

	// A memo mixing prose with checklist lines is not a pure checklist, so it
	// must be preserved verbatim as a text note rather than losing the prose.
	content := "Groceries:\n- [ ] buy milk\n- [x] walk the dog"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, client.NoteTypeText, notes[0].NoteType)
	assert.Equal(t, content, notes[0].Content)
}

func TestImportUsememosChecklistWithTags(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememoschecklist3", "password123", false)

	// Hashtags on their own line are stripped before checklist detection, so the
	// remaining body is a pure checklist and still imports as a list note while
	// the tag becomes a label.
	content := "#chores\n- [ ] buy milk\n- [x] walk the dog"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, client.NoteTypeList, notes[0].NoteType)

	labelNames := make([]string, 0, len(notes[0].Labels))
	for _, l := range notes[0].Labels {
		labelNames = append(labelNames, l.Name)
	}
	assert.Equal(t, []string{"chores"}, labelNames)

	note, err := user.Client.GetNote(t.Context(), notes[0].ID)
	require.NoError(t, err)
	require.Len(t, note.Items, 2)
	assert.Equal(t, "buy milk", note.Items[0].Text)
	assert.Equal(t, "walk the dog", note.Items[1].Text)
	assert.True(t, note.Items[1].Completed)
}

func TestImportUsememosPagination(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser7", "password123", false)

	page1 := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Page 1 memo"},
	}
	page2 := []map[string]any{
		{"name": "memos/2", "state": "NORMAL", "content": "Page 2 memo"},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{
		{memos: page1, nextPageToken: "token2"},
		{memos: page2},
	})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
}

func TestImportUsememosInvalidURLReturns400(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser8", "password123", false)

	_, err := user.Client.ImportUsememos(t.Context(), "ftp://not-http.example.com", "testtoken")
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestImportUsememosMissingURLReturns400(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser9", "password123", false)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("import_type", "usememos"))
	require.NoError(t, mw.WriteField("token", "tok"))
	require.NoError(t, mw.Close())

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestImportUsememosUnauthenticatedReturns401(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	memos := []map[string]any{{"name": "memos/1", "state": "NORMAL", "content": "hello"}}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("import_type", "usememos"))
	require.NoError(t, mw.WriteField("url", mockSrv.URL))
	require.NoError(t, mw.WriteField("token", "testtoken"))
	require.NoError(t, mw.Close())

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := ts.HTTPServer.Client().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestImportUsememosOlderAPIFormat(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosuser10", "password123", false)

	// Simulate the older API format using "data" and "rowStatus" fields.
	// The server filters by the requested state, mapping rowStatus → state
	// (NORMAL → NORMAL, ARCHIVED → ARCHIVED).
	all := []map[string]any{
		{"id": 1, "rowStatus": "NORMAL", "content": "Old format memo"},
		{"id": 2, "rowStatus": "ARCHIVED", "content": "Old archived"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != usememosTestPath {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != usememosTestAuth {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		state := r.URL.Query().Get("state")
		filtered := make([]map[string]any, 0, len(all))
		for _, m := range all {
			rs, _ := m["rowStatus"].(string)
			mapped := stateActive
			if rs == stateArchived {
				mapped = stateArchived
			}
			if mapped == state {
				filtered = append(filtered, m)
			}
		}
		resp := map[string]any{"data": filtered}
		assert.NoError(t, json.NewEncoder(w).Encode(resp))
	}))
	defer srv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), srv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)

	archived, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
	require.NoError(t, err)
	var found bool
	for _, n := range archived {
		if n.Content == "Old archived" {
			found = true
			assert.True(t, n.Archived)
		}
	}
	assert.True(t, found)
}

// TestImportUsememosDeletedMemoFromServerSkipped verifies importSingleMemo's
// defensive DELETED-skip branch. Real Memos servers only return NORMAL/ARCHIVED
// memos when queried with state=NORMAL/ARCHIVED, but a buggy or legacy server
// could return a DELETED memo anyway — the importer must skip it rather than
// importing a "deleted" record. This test uses a mock that does NOT filter by
// state so a DELETED memo reaches the importer.
func TestImportUsememosDeletedMemoFromServerSkipped(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosdeleted", "password123", false)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != usememosTestPath || r.Header.Get("Authorization") != usememosTestAuth {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		// Return both memos regardless of the requested state — simulating a
		// non-conforming server that ignores the state filter.
		resp := map[string]any{"memos": []map[string]any{
			{"name": "memos/1", "state": "DELETED", "content": "should be skipped"},
			{"name": "memos/2", "state": stateActive, "content": "should be imported"},
		}}
		assert.NoError(t, json.NewEncoder(w).Encode(resp))
	}))
	defer srv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), srv.URL, "testtoken")
	require.NoError(t, err)
	// The server is queried twice (NORMAL + ARCHIVED) and returns both memos
	// each time, so the deduplicated-by-position counts are 2 imported (the
	// NORMAL memo, once per pass) and 2 skipped (the DELETED memo, once per
	// pass). What matters is that the DELETED memo is never imported.
	assert.Equal(t, 2, result.Imported)
	assert.Equal(t, 2, result.Skipped)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	for _, n := range notes {
		assert.NotEqual(t, "should be skipped", n.Content, "DELETED memo must not be imported")
	}
}

// TestImportUsememosEmptyMemoSkipped verifies that memos with no content and no
// tags (e.g. a Memos memo that contained only attachments/resources) are skipped
// rather than imported as blank notes.
func TestImportUsememosEmptyMemoSkipped(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosempty", "password123", false)

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": ""},
		{"name": "memos/2", "state": "NORMAL", "content": "real content"},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 1, result.Skipped)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, "real content", notes[0].Content)
}

// TestImportUsememosAPITagsMergedWithExtracted verifies that tags returned by
// the Memos API in the `tags` field are imported as labels alongside hashtags
// extracted from content, deduplicated case-insensitively.
func TestImportUsememosAPITagsMergedWithExtracted(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosapitags", "password123", false)

	memos := []map[string]any{
		{
			"name":    "memos/1",
			"state":   "NORMAL",
			"content": "Body #inline",
			"tags":    []string{"fromapi", "INLINE", "  spaced  "},
		},
	}
	mockSrv := buildUsememosServer(t, []usememosPage{{memos: memos}})
	defer mockSrv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), mockSrv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)

	labelNames := make([]string, 0, len(notes[0].Labels))
	for _, l := range notes[0].Labels {
		labelNames = append(labelNames, l.Name)
	}
	// "inline" from content; "fromapi" and "spaced" from API tags;
	// "INLINE" is deduped case-insensitively against "inline".
	assert.ElementsMatch(t, []string{"inline", "fromapi", "spaced"}, labelNames)
}

// TestImportUsememosArchivedFetchedSeparately verifies that the importer
// issues separate paginated requests for NORMAL and ARCHIVED states, matching
// the Memos v1 API which only returns NORMAL memos by default.
func TestImportUsememosArchivedFetchedSeparately(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememostwopass", "password123", false)

	var activeCalls, archivedCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != usememosTestPath || r.Header.Get("Authorization") != usememosTestAuth {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		state := r.URL.Query().Get("state")
		var memos []map[string]any
		switch state {
		case stateActive:
			activeCalls++
			memos = []map[string]any{{"name": "memos/1", "state": stateActive, "content": "active memo"}}
		case stateArchived:
			archivedCalls++
			memos = []map[string]any{{"name": "memos/2", "state": stateArchived, "content": "archived memo"}}
		default:
			http.Error(w, "missing state", http.StatusBadRequest)
			assert.Failf(t, "unexpected state", "got %q", state)
			return
		}
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{"memos": memos}))
	}))
	defer srv.Close()

	result, err := user.Client.ImportUsememos(t.Context(), srv.URL, "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
	assert.GreaterOrEqual(t, activeCalls, 1)
	assert.GreaterOrEqual(t, archivedCalls, 1)

	archived, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
	require.NoError(t, err)
	var foundArchived bool
	for _, n := range archived {
		if n.Content == "archived memo" {
			foundArchived = true
			assert.True(t, n.Archived)
		}
	}
	assert.True(t, foundArchived, "archived memo should be imported with archived=true")
}
