package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// keepNoteJSON is a minimal valid Google Keep JSON payload.
type keepNoteJSON struct {
	Title       string             `json:"title"`
	TextContent string             `json:"textContent"`
	ListContent []keepNoteItemJSON `json:"listContent,omitempty"`
	Labels      []keepLabelJSON    `json:"labels,omitempty"`
	IsTrashed   bool               `json:"isTrashed"`
	IsPinned    bool               `json:"isPinned"`
	IsArchived  bool               `json:"isArchived"`
	Color       string             `json:"color,omitempty"`
	// Unix microseconds; zero leaves the field out, as Takeout may.
	CreatedTimestampUsec    int64 `json:"createdTimestampUsec,omitempty"`
	UserEditedTimestampUsec int64 `json:"userEditedTimestampUsec,omitempty"`
}

type keepNoteItemJSON struct {
	Text      string `json:"text"`
	IsChecked bool   `json:"isChecked"`
}

type keepLabelJSON struct {
	Name string `json:"name"`
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

// TestImportInvalidUTF8 pins that note text carrying a truncated emoji (a lone
// UTF-16 surrogate escape) or raw invalid UTF-8 still imports, through every
// importer, with the bad sequence replaced by U+FFFD. encoding/json/v2 rejects
// both by default; see unmarshalImport.
func TestImportInvalidUTF8(t *testing.T) {
	t.Parallel()
	// Serves the usememos subtest; the file-import subtests never reach it.
	ts, _ := setupUsememosTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != usememosTestPath || r.Header.Get("Authorization") != usememosTestAuth {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("state") != stateActive {
			_, _ = w.Write([]byte(`{"memos":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"memos":[` +
			`{"name":"memos/1","state":"NORMAL","content":"broken \ud83d emoji"},` +
			`{"name":"memos/2","state":"NORMAL","content":"intact"}]}`))
	}))

	surrogate := []byte(`{"title":"Surrogate","textContent":"broken \ud83d emoji"}`)
	invalid := append(append([]byte(`{"title":"Invalid","textContent":"bad `), 0xff), []byte(`byte"}`)...)

	listContents := func(t *testing.T, user *TestUser) []string {
		t.Helper()
		notes, err := user.Client.ListNotes(t.Context(), nil)
		require.NoError(t, err)
		contents := make([]string, 0, len(notes))
		for _, n := range notes {
			contents = append(contents, n.Content)
		}
		return contents
	}

	t.Run("keep zip", func(t *testing.T) {
		user := ts.createTestUser(t, "importutf8zip", "password123", false)
		zipData := buildZip(t, map[string][]byte{"surrogate.json": surrogate, "invalid.json": invalid})

		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "export.zip", bytes.NewReader(zipData))
		require.NoError(t, err)
		assert.Equal(t, 2, result.Imported)
		assert.ElementsMatch(t, []string{
			"# Surrogate\n\nbroken \uFFFD emoji",
			"# Invalid\n\nbad \uFFFDbyte",
		}, listContents(t, user))
	})

	t.Run("keep single file", func(t *testing.T) {
		user := ts.createTestUser(t, "importutf8file", "password123", false)

		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(surrogate))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		assert.Equal(t, []string{"# Surrogate\n\nbroken \uFFFD emoji"}, listContents(t, user))
	})

	t.Run("usememos page", func(t *testing.T) {
		user := ts.createTestUser(t, "importutf8memos", "password123", false)

		result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
		require.NoError(t, err)
		assert.Equal(t, 2, result.Imported)
		assert.ElementsMatch(t, []string{"broken \uFFFD emoji", "intact"}, listContents(t, user))
	})
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
	assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
}

func TestImportCorruptZIPReturns400(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importuser6", "password123", false)

	corrupt := []byte{'P', 'K', 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF}
	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "bad.zip", bytes.NewReader(corrupt))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
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

func TestImportKeepColorsMapToPalette(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importcolors", "password123", false)

	// Every expected value is a NOTE_COLORS swatch (shared/src/colors.ts), so
	// imported notes show a selected swatch in the picker.
	want := map[string]string{
		"DEFAULT":  "#ffffff",
		"RED":      "#f28b82",
		"ORANGE":   "#fbbc04",
		"YELLOW":   "#fbbc04",
		"GREEN":    "#ccff90",
		"TEAL":     "#a7ffeb",
		"BLUE":     "#aecbfa",
		"CERULEAN": "#aecbfa",
		"PURPLE":   "#d7aefb",
		"PINK":     "#fdcfe8",
		"BROWN":    "#e6c9a8",
		"GRAY":     "#e8eaed",
		"unknown":  "#ffffff",
	}
	files := make(map[string][]byte, len(want))
	for keepColor := range want {
		files[keepColor+".json"] = marshalKeepNote(t, keepNoteJSON{TextContent: "keep color " + keepColor, Color: keepColor})
	}
	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "takeout.zip", bytes.NewReader(buildZip(t, files)))
	require.NoError(t, err)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	got := make(map[string]string, len(notes))
	for _, n := range notes {
		if keepColor, ok := strings.CutPrefix(n.Content, "keep color "); ok {
			got[keepColor] = n.Color
		}
	}
	assert.Equal(t, want, got)
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

// setupUsememosTestServer starts a mock Memos server serving h and a Jot test
// server whose JOT_MEMOS_URL points at it, and returns the Jot server and the
// mock's URL.
func setupUsememosTestServer(t *testing.T, h http.Handler) (*TestServer, string) {
	t.Helper()
	memos := httptest.NewServer(h)
	t.Cleanup(memos.Close)
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { cfg.MemosURL = memos.URL })
	return ts, memos.URL
}

// postUsememosImport sends a raw usememos import request with the given form
// fields through c, for the cases the typed client cannot express, and returns
// the response status and body.
func postUsememosImport(t *testing.T, ts *TestServer, c *http.Client, fields map[string]string) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("import_type", "usememos"))
	for k, v := range fields {
		require.NoError(t, mw.WriteField(k, v))
	}
	require.NoError(t, mw.Close())

	status, _, body := rawRequest(t, c, http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf, http.Header{"Content-Type": {mw.FormDataContentType()}})
	return status, body
}

const importOptionsPath = "/api/v1/notes/import/options"

// buildUsememosHandler serves pages of mock usememos
// API responses at GET /api/v1/memos. The pages slice is served in order, filtered
// by the request's `state` query parameter — only memos whose `state` field matches
// the requested state are returned (this mirrors the real Memos v1 API, which only
// returns NORMAL memos by default and requires a separate ?state=ARCHIVED pass for
// archived memos). Pagination state is tracked independently per state. Requests
// must carry "Authorization: Bearer testtoken" and a `state` query parameter.
func buildUsememosHandler(t *testing.T, pages []usememosPage) http.Handler {
	t.Helper()
	pageIdxByState := map[string]int{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	})
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

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Hello world", "pinned": false},
		{"name": "memos/2", "state": "NORMAL", "content": "Second memo", "pinned": false},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosuser1", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
	assert.Equal(t, 0, result.Skipped)
	assert.Empty(t, result.Errors)
}

func TestImportUsememosDeletedSkipped(t *testing.T) {
	t.Parallel()

	// The Memos v1 API only returns NORMAL or ARCHIVED memos in response to
	// ?state=NORMAL / ?state=ARCHIVED queries (which is all the importer issues),
	// so DELETED memos are filtered server-side and never reach the importer.
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Keep me"},
		{"name": "memos/2", "state": "DELETED", "content": "Delete me"},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosuser2", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 0, result.Skipped)
}

func TestImportUsememosArchivedImportedAsArchived(t *testing.T) {
	t.Parallel()

	memos := []map[string]any{
		{"name": "memos/1", "state": "ARCHIVED", "content": "Archived memo"},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosuser3", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Pinned memo", "pinned": true},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosuser4", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "My note #golang #testing"},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosuser5", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	content := "Before\n```\n#notag\n```\nAfter #realtag"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosuser6", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	content := "- [ ] buy milk\n- [x] walk the dog\n  - [ ] feed the cat"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememoschecklist1", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	// A heading on the first line followed by a checklist becomes a titled list
	// note: the heading is the note title and the remaining lines are items.
	content := "# Groceries\n- [ ] buy milk\n- [x] walk the dog"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememoschecklist4", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	// A heading with non-checklist body is not a todo list and must stay a text
	// note that preserves the full Markdown content.
	content := "# Journal\nToday I learned a lot."
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememoschecklist5", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	// A memo mixing prose with checklist lines is not a pure checklist, so it
	// must be preserved verbatim as a text note rather than losing the prose.
	content := "Groceries:\n- [ ] buy milk\n- [x] walk the dog"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememoschecklist2", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	// Hashtags on their own line are stripped before checklist detection, so the
	// remaining body is a pure checklist and still imports as a list note while
	// the tag becomes a label.
	content := "#chores\n- [ ] buy milk\n- [x] walk the dog"
	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": content},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememoschecklist3", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	page1 := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "Page 1 memo"},
	}
	page2 := []map[string]any{
		{"name": "memos/2", "state": "NORMAL", "content": "Page 2 memo"},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{
		{memos: page1, nextPageToken: "token2"},
		{memos: page2},
	}))
	user := ts.createTestUser(t, "usememosuser7", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
}

// TestImportUsememosIgnoresURLField verifies the import always fetches from
// JOT_MEMOS_URL, never from a url the request names.
func TestImportUsememosIgnoresURLField(t *testing.T) {
	t.Parallel()

	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": "from the configured instance"},
	}}}))
	user := ts.createTestUser(t, "usememosurlfield", "password123", false)
	var otherHit atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		otherHit.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer other.Close()

	status, body := postUsememosImport(t, ts, user.Client.HTTPClient(), map[string]string{"url": other.URL, "token": "testtoken"})
	require.Equal(t, http.StatusOK, status)
	var result client.ImportResponse
	require.NoError(t, json.Unmarshal(body, &result))
	assert.Equal(t, 1, result.Imported)
	assert.Empty(t, result.Errors)
	assert.False(t, otherHit.Load(), "the url form field must not be contacted")
	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, "from the configured instance", notes[0].Content)
}

func TestImportUsememosDisabledWithoutConfig(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "usememosdisabled", "password123", false)

	_, err := user.Client.ImportUsememos(t.Context(), "testtoken")
	assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
	assert.Equal(t, "memos_import_disabled", client.ErrorCode(err))
}

func TestImportUsememosMissingTokenReturns400(t *testing.T) {
	t.Parallel()
	ts, _ := setupUsememosTestServer(t, http.NotFoundHandler())
	user := ts.createTestUser(t, "usememosuser9", "password123", false)

	status, _ := postUsememosImport(t, ts, user.Client.HTTPClient(), nil)
	assert.Equal(t, http.StatusBadRequest, status)
}

// TestImportUsememosRedirectNotFollowed verifies a 3xx from the Memos server
// is reported, naming the target, rather than followed to another host.
func TestImportUsememosRedirectNotFollowed(t *testing.T) {
	t.Parallel()

	var targetHit atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHit.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	// Each subtest sets where the mock redirects to; they run one at a time.
	var redirectTo atomic.Value
	ts, _ := setupUsememosTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirectTo.Load().(string), http.StatusFound)
	}))
	user := ts.createTestUser(t, "usememosredirect", "password123", false)

	t.Run("same API path", func(t *testing.T) {
		redirectTo.Store(target.URL + "/memos/api/v1/memos")

		result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
		require.NoError(t, err)
		assert.Zero(t, result.Imported)
		require.Len(t, result.Errors, 1)
		assert.Contains(t, result.Errors[0], "redirected to "+target.URL+"/memos/api/v1/memos")
		assert.Contains(t, result.Errors[0], "set JOT_MEMOS_URL to "+target.URL+"/memos")
	})

	t.Run("elsewhere", func(t *testing.T) {
		redirectTo.Store(target.URL + "/login")

		result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
		require.NoError(t, err)
		require.Len(t, result.Errors, 1)
		assert.Contains(t, result.Errors[0], "redirected to "+target.URL+"/login")
		assert.Contains(t, result.Errors[0], "check JOT_MEMOS_URL")
	})

	t.Run("truncated body", func(t *testing.T) {
		// A redirect whose body is cut short must still be reported as a
		// redirect, not as a failed body read.
		ts, _ := setupUsememosTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Location", target.URL+"/memos/api/v1/memos")
			w.Header().Set("Content-Length", "1000")
			w.WriteHeader(http.StatusFound)
			_, _ = w.Write([]byte("short"))
		}))
		user := ts.createTestUser(t, "usememosredirect3", "password123", false)

		result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
		require.NoError(t, err)
		require.Len(t, result.Errors, 1)
		assert.Contains(t, result.Errors[0], "set JOT_MEMOS_URL to "+target.URL+"/memos")
	})

	assert.False(t, targetHit.Load(), "the redirect must not be followed")
}

func TestImportUsememosUnauthenticatedReturns401(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	status, _ := postUsememosImport(t, ts, ts.HTTPServer.Client(), map[string]string{"token": "testtoken"})
	assert.Equal(t, http.StatusUnauthorized, status)
}

func TestImportOptions(t *testing.T) {
	t.Parallel()

	t.Run("configured", func(t *testing.T) {
		ts, memosURL := setupUsememosTestServer(t, http.NotFoundHandler())
		user := ts.createTestUser(t, "importoptions1", "password123", false)

		opts, err := user.Client.ImportOptions(t.Context())
		require.NoError(t, err)
		require.NotNil(t, opts.Memos)
		assert.Equal(t, memosURL, opts.Memos.URL)

		status, _, _ := rawRequest(t, ts.HTTPServer.Client(), http.MethodGet, ts.HTTPServer.URL+importOptionsPath, nil, nil)
		assert.Equal(t, http.StatusUnauthorized, status, "requires auth")
	})

	t.Run("not configured", func(t *testing.T) {
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "importoptions2", "password123", false)

		status, _, body := rawRequest(t, user.Client.HTTPClient(), http.MethodGet, ts.HTTPServer.URL+importOptionsPath, nil, nil)
		require.Equal(t, http.StatusOK, status)
		assert.JSONEq(t, `{"memos":null}`, string(body))
	})
}

func TestImportUsememosOlderAPIFormat(t *testing.T) {
	t.Parallel()

	// Simulate the older API format using "data" and "rowStatus" fields.
	// The server filters by the requested state, mapping rowStatus → state
	// (NORMAL → NORMAL, ARCHIVED → ARCHIVED).
	all := []map[string]any{
		{"id": 1, "rowStatus": "NORMAL", "content": "Old format memo"},
		{"id": 2, "rowStatus": "ARCHIVED", "content": "Old archived"},
	}
	ts, _ := setupUsememosTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	user := ts.createTestUser(t, "usememosuser10", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	ts, _ := setupUsememosTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	user := ts.createTestUser(t, "usememosdeleted", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	memos := []map[string]any{
		{"name": "memos/1", "state": "NORMAL", "content": ""},
		{"name": "memos/2", "state": "NORMAL", "content": "real content"},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosempty", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	memos := []map[string]any{
		{
			"name":    "memos/1",
			"state":   "NORMAL",
			"content": "Body #inline",
			"tags":    []string{"fromapi", "INLINE", "  spaced  "},
		},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememosapitags", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

	var activeCalls, archivedCalls int
	ts, _ := setupUsememosTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	user := ts.createTestUser(t, "usememostwopass", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
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

func TestImportKeepTimestamps(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "keeptimestamps", "password123", false)

	files := map[string][]byte{
		"Takeout/Keep/dated.json": marshalKeepNote(t, keepNoteJSON{
			TextContent:             "dated",
			CreatedTimestampUsec:    1583298367123456,
			UserEditedTimestampUsec: 1628503872000000,
		}),
		"Takeout/Keep/undated.json": marshalKeepNote(t, keepNoteJSON{TextContent: "undated"}),
	}
	result, err := user.Client.ImportNotes(t.Context(), "google_keep", "takeout.zip", bytes.NewReader(buildZip(t, files)))
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)

	notes := notesByContent(t, user)
	assertNoteTimes(t, notes["dated"], time.Date(2020, 3, 4, 5, 6, 7, 123456000, time.UTC), time.Date(2021, 8, 9, 10, 11, 12, 0, time.UTC))
	assertNoteTimes(t, notes["undated"], time.Time{}, time.Time{})
}

func TestImportUsememosTimestamps(t *testing.T) {
	t.Parallel()

	memos := []map[string]any{
		{"name": "memos/1", "content": "v1 fields", "createTime": "2020-03-04T05:06:07.123456Z", "updateTime": "2021-08-09T12:11:12+02:00"},
		{"name": "memos/2", "content": "older fields", "createdTs": 1583298367, "updatedTs": 1628503872},
		{"name": "memos/3", "content": "unparsable", "createTime": "yesterday", "updateTime": "tomorrow"},
	}
	ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
	user := ts.createTestUser(t, "usememostimestamps", "password123", false)

	result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
	require.NoError(t, err)
	assert.Equal(t, 3, result.Imported)

	notes := notesByContent(t, user)
	assertNoteTimes(t, notes["v1 fields"], time.Date(2020, 3, 4, 5, 6, 7, 123456000, time.UTC), time.Date(2021, 8, 9, 10, 11, 12, 0, time.UTC))
	assertNoteTimes(t, notes["older fields"], time.Date(2020, 3, 4, 5, 6, 7, 0, time.UTC), time.Date(2021, 8, 9, 10, 11, 12, 0, time.UTC))
	assertNoteTimes(t, notes["unparsable"], time.Time{}, time.Time{})
}

// failNoteItemInserts installs a trigger that aborts any note_items insert whose
// text is "boom", simulating a database failure partway through a list note.
func failNoteItemInserts(t *testing.T, ts *TestServer) {
	t.Helper()
	if ts.dialect.Driver == dialect.DriverPostgres {
		ts.exec(t, `CREATE FUNCTION fail_boom_item() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.text = 'boom' THEN RAISE EXCEPTION 'injected item failure'; END IF;
				RETURN NEW;
			END $$;
			CREATE TRIGGER fail_boom_item BEFORE INSERT ON note_items
				FOR EACH ROW EXECUTE FUNCTION fail_boom_item()`)
		return
	}
	ts.exec(t, `CREATE TRIGGER fail_boom_item BEFORE INSERT ON note_items
		WHEN NEW.text = 'boom'
		BEGIN SELECT RAISE(ABORT, 'injected item failure'); END`)
}

// allNotes returns the user's active and archived notes.
func allNotes(t *testing.T, user *TestUser) []client.Note {
	t.Helper()
	active, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	archived, err := user.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
	require.NoError(t, err)
	return append(active, archived...)
}

// notesByContent returns all of user's notes, active and archived, by content.
func notesByContent(t *testing.T, user *TestUser) map[string]client.Note {
	t.Helper()
	byContent := map[string]client.Note{}
	for _, n := range allNotes(t, user) {
		byContent[n.Content] = n
	}
	return byContent
}

// assertNoteTimes checks n's created_at and updated_at against wantCreated and
// wantUpdated, where a zero want means the import time: within a minute of now.
func assertNoteTimes(t *testing.T, n client.Note, wantCreated, wantUpdated time.Time) {
	t.Helper()
	check := func(field string, got, want time.Time) {
		if want.IsZero() {
			assert.WithinDuration(t, time.Now(), got, time.Minute, "%s should be the import time", field)
			return
		}
		assert.True(t, want.Equal(got), "%s is %v, want %v", field, got, want)
	}
	check("created_at", n.CreatedAt, wantCreated)
	check("updated_at", n.UpdatedAt, wantUpdated)
}

func labelNames(labels []client.Label) []string {
	names := make([]string, 0, len(labels))
	for _, l := range labels {
		names = append(names, l.Name)
	}
	return names
}

func TestImportFailureLeavesNoPartialNote(t *testing.T) {
	t.Parallel()

	t.Run("google keep", func(t *testing.T) {
		t.Parallel()
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "importatomickeep", "password123", false)
		failNoteItemInserts(t, ts)

		broken := marshalKeepNote(t, keepNoteJSON{
			Title:       "Broken List",
			IsPinned:    true,
			Labels:      []keepLabelJSON{{Name: "Broken"}},
			ListContent: []keepNoteItemJSON{{Text: "first"}, {Text: "boom"}, {Text: "third"}},
		})
		good := marshalKeepNote(t, keepNoteJSON{Title: "Good List", ListContent: []keepNoteItemJSON{{Text: "fine"}}})
		zipData := buildZip(t, map[string][]byte{"broken.json": broken, "good.json": good})

		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "export.zip", bytes.NewReader(zipData))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		require.Len(t, result.Errors, 1)
		assert.Contains(t, result.Errors[0], "Broken List")

		notes := allNotes(t, user)
		require.Len(t, notes, 1, "the failed note must not be left behind partially")
		assert.Equal(t, "Good List", notes[0].Title)
		assert.Empty(t, notes[0].Labels)
	})

	t.Run("usememos", func(t *testing.T) {
		t.Parallel()
		memos := []map[string]any{
			{"name": "memos/1", "state": "NORMAL", "pinned": true, "content": "# Broken\n- [ ] first\n- [ ] boom\n- [ ] third #broken"},
			{"name": "memos/2", "state": "NORMAL", "content": "plain memo"},
		}
		ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
		failNoteItemInserts(t, ts)
		user := ts.createTestUser(t, "importatomicmemos", "password123", false)

		result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		assert.Equal(t, 1, result.Skipped)
		require.Len(t, result.Errors, 1)
		assert.Contains(t, result.Errors[0], "memo #1")

		notes := allNotes(t, user)
		require.Len(t, notes, 1, "the failed memo must not be left behind partially")
		assert.Equal(t, "plain memo", notes[0].Content)

		labels, err := user.Client.ListLabels(t.Context())
		require.NoError(t, err)
		assert.Empty(t, labels, "labels of the failed memo must be rolled back")
	})
}

func TestImportPreservesNoteState(t *testing.T) {
	t.Parallel()

	t.Run("google keep", func(t *testing.T) {
		t.Parallel()
		ts := setupTestServer(t)
		user := ts.createTestUser(t, "importstatekeep", "password123", false)

		data := marshalKeepNote(t, keepNoteJSON{
			Title:       "Stateful List",
			IsPinned:    true,
			IsArchived:  true,
			Labels:      []keepLabelJSON{{Name: "Work"}, {Name: "Errands"}},
			ListContent: []keepNoteItemJSON{{Text: "one", IsChecked: true}, {Text: "two"}},
		})
		result, err := user.Client.ImportNotes(t.Context(), "google_keep", "note.json", bytes.NewReader(data))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		assert.Empty(t, result.Errors)

		notes := allNotes(t, user)
		require.Len(t, notes, 1)
		assert.True(t, notes[0].Pinned)
		assert.True(t, notes[0].Archived)
		assert.ElementsMatch(t, []string{"Work", "Errands"}, labelNames(notes[0].Labels))

		note, err := user.Client.GetNote(t.Context(), notes[0].ID)
		require.NoError(t, err)
		require.Len(t, note.Items, 2)
		assert.Equal(t, "one", note.Items[0].Text)
		assert.True(t, note.Items[0].Completed)
		assert.Equal(t, "two", note.Items[1].Text)
		assert.False(t, note.Items[1].Completed)
	})

	t.Run("usememos", func(t *testing.T) {
		t.Parallel()

		memos := []map[string]any{{
			"name":    "memos/1",
			"state":   "ARCHIVED",
			"pinned":  true,
			"tags":    []string{"home"},
			"content": "# Chores #weekly\n- [ ] kitchen\n  - [x] dishes\n- [ ] garden",
		}}
		ts, _ := setupUsememosTestServer(t, buildUsememosHandler(t, []usememosPage{{memos: memos}}))
		user := ts.createTestUser(t, "importstatememos", "password123", false)

		result, err := user.Client.ImportUsememos(t.Context(), "testtoken")
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		assert.Empty(t, result.Errors)

		notes := allNotes(t, user)
		require.Len(t, notes, 1)
		assert.True(t, notes[0].Pinned)
		assert.True(t, notes[0].Archived)
		assert.Equal(t, "Chores", notes[0].Title)
		assert.ElementsMatch(t, []string{"weekly", "home"}, labelNames(notes[0].Labels))

		note, err := user.Client.GetNote(t.Context(), notes[0].ID)
		require.NoError(t, err)
		require.Len(t, note.Items, 3)
		assert.Equal(t, "kitchen", note.Items[0].Text)
		assert.Nil(t, note.Items[0].ParentID)
		assert.Equal(t, "dishes", note.Items[1].Text)
		assert.True(t, note.Items[1].Completed)
		require.NotNil(t, note.Items[1].ParentID)
		assert.Equal(t, note.Items[0].ID, *note.Items[1].ParentID)
		assert.Equal(t, "garden", note.Items[2].Text)
		assert.Nil(t, note.Items[2].ParentID)
	})
}

func TestImportOversizeReturns413(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "importoversize", "password123", false)

	oversized := bytes.Repeat([]byte{'x'}, 33<<20)
	_, err := user.Client.ImportNotes(t.Context(), "google_keep", "big.json", bytes.NewReader(oversized))
	assert.Equal(t, http.StatusRequestEntityTooLarge, client.StatusCode(err))
	assert.Equal(t, "request_too_large", client.ErrorCode(err))
}
