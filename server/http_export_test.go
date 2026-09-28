package main

import (
	"bytes"
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExportUnauthenticatedReturns401(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/export", nil)
	require.NoError(t, err)

	resp, err := ts.HTTPServer.Client().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestExportEmptyAccount(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportempty", "password123", false)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "jot_export", export.Manifest.Format)
	assert.Equal(t, 2, export.Manifest.Version)
	assert.NotZero(t, export.Manifest.ExportedAt)
	assert.NotNil(t, export.Manifest.Notes)
	assert.Empty(t, export.Manifest.Notes)
}

func TestExportEnvelopeShape(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportshape", "password123", false)

	_, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "Some content",
	})
	require.NoError(t, err)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "jot_export", export.Manifest.Format)
	assert.Equal(t, 2, export.Manifest.Version)
	require.Len(t, export.Manifest.Notes, 1)
	assert.Empty(t, export.Manifest.Notes[0].Title)
	assert.Equal(t, "Some content", export.Manifest.Notes[0].Content)
	assert.Equal(t, client.NoteTypeText, export.Manifest.Notes[0].NoteType)
	assert.NotNil(t, export.Manifest.Notes[0].Labels)
}

func TestExportOnlyOwnedNotes(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "exportowner", "password123", false)
	other := ts.createTestUser(t, "exportother", "password123", false)

	ownerNote, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Owner Note"})
	require.NoError(t, err)

	// Share owner's note with other user.
	err = owner.Client.ShareNote(t.Context(), ownerNote.ID, other.User.ID)
	require.NoError(t, err)

	// Create a note owned by other.
	_, err = other.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Other Note"})
	require.NoError(t, err)

	// other's export should only contain "Other Note", not the shared "Owner Note".
	export, err := other.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	require.Len(t, export.Manifest.Notes, 1)
	assert.Equal(t, "Other Note", export.Manifest.Notes[0].Content)
}

func TestExportExcludesTrashedNotes(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exporttrash", "password123", false)

	active, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Active"})
	require.NoError(t, err)
	trashed, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Trashed"})
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNote(t.Context(), trashed.ID))

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	require.Len(t, export.Manifest.Notes, 1)
	assert.Equal(t, active.Content, export.Manifest.Notes[0].Content)
}

func TestExportIncludesArchivedNotes(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportarchived", "password123", false)

	archived := true
	_, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Active"})
	require.NoError(t, err)
	archivedNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Archived"})
	require.NoError(t, err)
	_, err = user.Client.UpdateTextNote(t.Context(), archivedNote.ID, &client.UpdateTextNoteRequest{Archived: &archived})
	require.NoError(t, err)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Len(t, export.Manifest.Notes, 2)
}

func TestExportResponseHeaders(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportheaders", "password123", false)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/export", nil)
	require.NoError(t, err)

	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "application/zip", resp.Header.Get("Content-Type"))
	assert.Contains(t, resp.Header.Get("Content-Disposition"), "attachment")
	assert.Contains(t, resp.Header.Get("Content-Disposition"), "jot-export-")
	assert.Contains(t, resp.Header.Get("Content-Disposition"), ".zip")
}

// jotBundle packs manifest (the notes.json text) and images (bundle entry
// name -> bytes) into a Jot export zip.
func jotBundle(t *testing.T, manifest string, images map[string][]byte) []byte {
	t.Helper()
	files := map[string][]byte{client.JotExportManifest: []byte(manifest)}
	maps.Copy(files, images)
	return buildZip(t, files)
}

// --- Jot import tests ---

func TestImportJotJSONBasic(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotimport1", "password123", false)

	// The "title" field in the JSON is for a text note — it will be silently stripped
	// on import since text notes do not have titles; only "content" is preserved.
	payload := `{
		"format": "jot_export",
		"version": 2,
		"exported_at": "2026-01-01T00:00:00Z",
		"notes": [
			{
				"title": "Hello",
				"content": "World",
				"note_type": "text",
				"color": "#ffffff",
				"pinned": false,
				"archived": false,
				"position": 0,
				"labels": []
			}
		]
	}`

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 0, result.Skipped)
	assert.Empty(t, result.Errors)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	// Title is stripped for text notes on import; only content is preserved.
	assert.Empty(t, notes[0].Title)
	assert.Equal(t, "World", notes[0].Content)
}

func TestImportJotJSONInvalidFormat(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotimport2", "password123", false)

	t.Run("wrong format marker", func(t *testing.T) {
		payload := `{"format":"google_keep","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[]}`
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
	})

	t.Run("unsupported version", func(t *testing.T) {
		payload := `{"format":"jot_export","version":99,"exported_at":"2026-01-01T00:00:00Z","notes":[]}`
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
	})

	t.Run("notes is null", func(t *testing.T) {
		payload := `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":null}`
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
	})

	t.Run("not valid JSON", func(t *testing.T) {
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, "not json", nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
	})

	t.Run("google keep data with jot_json type", func(t *testing.T) {
		data := marshalKeepNote(t, keepNoteJSON{Title: "Keep Note", TextContent: "content"})
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(data), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		assert.Equal(t, "invalid_import_file", client.ErrorCode(err))
	})
}

func TestImportJotJSONValidation(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotimportval", "password123", false)

	makePayload := func(noteJSON string) []byte {
		return []byte(`{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[` + noteJSON + `]}`)
	}

	t.Run("unsupported note_type returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"drawing","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("title too long returns 400", func(t *testing.T) {
		longTitle, _ := json.Marshal(strings.Repeat("a", 201))
		payload := makePayload(`{"title":` + string(longTitle) + `,"content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("content too long returns 400", func(t *testing.T) {
		longContent, _ := json.Marshal(strings.Repeat("a", 10001))
		payload := makePayload(`{"title":"X","content":` + string(longContent) + `,"note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("invalid color returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"text","color":"notacolor","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("text note with items returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[],"items":[{"text":"item","completed":false,"position":0,"indent_level":0}]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("item text too long returns 400", func(t *testing.T) {
		longItem, _ := json.Marshal(strings.Repeat("a", 501))
		payload := makePayload(`{"title":"X","content":"","note_type":"list","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[],"items":[{"text":` + string(longItem) + `,"completed":false,"position":0,"indent_level":0}]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("invalid indent_level returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"list","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[],"items":[{"text":"item","completed":false,"position":0,"indent_level":5}]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, string(payload), nil)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}

func TestImportJotJSONRoundTrip(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	src := ts.createTestUser(t, "roundtripsrc", "password123", false)
	dst := ts.createTestUser(t, "roundtripdst", "password123", false)

	// Create a variety of notes for the source user.
	pinned := true
	archived := true
	srcPinned, err := src.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "pinned content",
		Color:   "#fbbc04",
	})
	require.NoError(t, err)
	_, err = src.Client.UpdateTextNote(t.Context(), srcPinned.ID, &client.UpdateTextNoteRequest{Pinned: &pinned})
	require.NoError(t, err)

	srcArchived, err := src.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "archived content",
	})
	require.NoError(t, err)
	_, err = src.Client.UpdateTextNote(t.Context(), srcArchived.ID, &client.UpdateTextNoteRequest{Archived: &archived})
	require.NoError(t, err)

	collapsed := true
	srcList, err := src.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "List Note",
		Items: []client.CreateNoteItem{
			{Text: "Item 1", Position: 0, IndentLevel: 0, Completed: true},
			{Text: "Item 2", Position: 1, IndentLevel: 1, Completed: false},
		},
	})
	require.NoError(t, err)
	_, err = src.Client.UpdateListNote(t.Context(), srcList.ID, &client.UpdateListNoteRequest{CheckedItemsCollapsed: &collapsed})
	require.NoError(t, err)

	// Create a label and attach it.
	_, err = src.Client.CreateLabel(t.Context(), "work")
	require.NoError(t, err)
	srcLabeled, err := src.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "Labeled Note",
		Labels:  []string{"work"},
	})
	require.NoError(t, err)
	_ = srcLabeled

	// Export source user's notes.
	export, err := src.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "jot_export", export.Manifest.Format)
	assert.Equal(t, 2, export.Manifest.Version)
	assert.Len(t, export.Manifest.Notes, 4)

	// Import into fresh destination user.
	result, err := dst.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(export.Data))
	require.NoError(t, err)
	assert.Equal(t, 4, result.Imported)
	assert.Equal(t, 0, result.Skipped)
	assert.Empty(t, result.Errors)

	// Verify imported notes.
	activeNotes, err := dst.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	archivedNotes, err := dst.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
	require.NoError(t, err)

	allNotes := slices.Concat(activeNotes, archivedNotes)
	assert.Len(t, allNotes, 4)

	// Look up notes by content or title depending on type.
	byContent := map[string]client.Note{}
	byTitle := map[string]client.Note{}
	for _, n := range allNotes {
		byContent[n.Content] = n
		byTitle[n.Title] = n
	}

	// Pinned note (text note — identified by content).
	pn, ok := byContent["pinned content"]
	require.True(t, ok)
	assert.True(t, pn.Pinned)
	assert.Equal(t, "#fbbc04", pn.Color)

	// Archived note (text note — identified by content).
	an, ok := byContent["archived content"]
	require.True(t, ok)
	assert.True(t, an.Archived)

	// List note with items (identified by title).
	tn, ok := byTitle["List Note"]
	require.True(t, ok)
	assert.Equal(t, client.NoteTypeList, tn.NoteType)
	assert.True(t, tn.CheckedItemsCollapsed)
	require.Len(t, tn.Items, 2)
	itemsByPos := map[int]client.NoteItem{}
	for _, item := range tn.Items {
		itemsByPos[item.Position] = item
	}
	assert.Equal(t, "Item 1", itemsByPos[0].Text)
	assert.True(t, itemsByPos[0].Completed)
	assert.Nil(t, itemsByPos[0].ParentID)
	assert.Equal(t, "Item 2", itemsByPos[1].Text)
	assert.False(t, itemsByPos[1].Completed)
	// Item 2 was imported at indent level 1, so it is nested under Item 1.
	require.NotNil(t, itemsByPos[1].ParentID)
	assert.Equal(t, itemsByPos[0].ID, *itemsByPos[1].ParentID)

	// Labeled note (text note — identified by content).
	ln, ok := byContent["Labeled Note"]
	require.True(t, ok)
	require.Len(t, ln.Labels, 1)
	assert.Equal(t, "work", ln.Labels[0].Name)
}

func TestImportJotJSONDuplicateImport(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotduplicate", "password123", false)

	payload := `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[{"title":"Dup","content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}]}`

	result1, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
	require.NoError(t, err)
	assert.Equal(t, 1, result1.Imported)

	result2, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
	require.NoError(t, err)
	assert.Equal(t, 1, result2.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	assert.Len(t, notes, 2, "duplicate import should create two distinct notes")
}

func TestImportJotJSONLabelsDeduplication(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotlabeldedupe", "password123", false)

	payload := `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[{"title":"N","content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":["work","work","  work  "]}]}`

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Len(t, notes[0].Labels, 1, "duplicate label names should be deduplicated")
	assert.Equal(t, "work", notes[0].Labels[0].Name)
}

func TestImportJotJSONEmptyColor(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotcolordefault", "password123", false)

	// Omitting color field should default to #ffffff.
	payload := `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[{"title":"No Color","content":"","note_type":"text","pinned":false,"archived":false,"position":0,"labels":[]}]}`

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(jotBundle(t, payload, nil)))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, "#ffffff", notes[0].Color)
}
