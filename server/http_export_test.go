package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExportUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/export", nil)
	require.NoError(t, err)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestExportEmptyAccount(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportempty", "password123", false)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "jot_export", export.Format)
	assert.Equal(t, 1, export.Version)
	assert.NotZero(t, export.ExportedAt)
	assert.NotNil(t, export.Notes)
	assert.Empty(t, export.Notes)
}

func TestExportEnvelopeShape(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportshape", "password123", false)

	_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:   "My Note",
		Content: "Some content",
	})
	require.NoError(t, err)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "jot_export", export.Format)
	assert.Equal(t, 1, export.Version)
	require.Len(t, export.Notes, 1)
	assert.Equal(t, "My Note", export.Notes[0].Title)
	assert.Equal(t, "Some content", export.Notes[0].Content)
	assert.Equal(t, client.NoteTypeText, export.Notes[0].NoteType)
	assert.NotNil(t, export.Notes[0].Labels)
}

func TestExportOnlyOwnedNotes(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "exportowner", "password123", false)
	other := ts.createTestUser(t, "exportother", "password123", false)

	ownerNote, err := owner.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Owner Note"})
	require.NoError(t, err)

	// Share owner's note with other user.
	err = owner.Client.ShareNote(t.Context(), ownerNote.ID, other.User.ID)
	require.NoError(t, err)

	// Create a note owned by other.
	_, err = other.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Other Note"})
	require.NoError(t, err)

	// other's export should only contain "Other Note", not the shared "Owner Note".
	export, err := other.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	require.Len(t, export.Notes, 1)
	assert.Equal(t, "Other Note", export.Notes[0].Title)
}

func TestExportExcludesTrashedNotes(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exporttrash", "password123", false)

	active, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Active"})
	require.NoError(t, err)
	trashed, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Trashed"})
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNote(t.Context(), trashed.ID))

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	require.Len(t, export.Notes, 1)
	assert.Equal(t, active.Title, export.Notes[0].Title)
}

func TestExportIncludesArchivedNotes(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportarchived", "password123", false)

	archived := true
	_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Active"})
	require.NoError(t, err)
	archivedNote, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "Archived"})
	require.NoError(t, err)
	_, err = user.Client.UpdateNote(t.Context(), archivedNote.ID, &client.UpdateNoteRequest{Archived: &archived})
	require.NoError(t, err)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Len(t, export.Notes, 2)
}

func TestExportResponseHeaders(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportheaders", "password123", false)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/export", nil)
	require.NoError(t, err)

	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "application/json", resp.Header.Get("Content-Type"))
	assert.Contains(t, resp.Header.Get("Content-Disposition"), "attachment")
	assert.Contains(t, resp.Header.Get("Content-Disposition"), "jot-export-")
	assert.Contains(t, resp.Header.Get("Content-Disposition"), ".json")
}

// --- Jot JSON import tests ---

func TestImportJotJSONBasic(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotimport1", "password123", false)

	payload := `{
		"format": "jot_export",
		"version": 1,
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

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	assert.Equal(t, 0, result.Skipped)
	assert.Empty(t, result.Errors)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, "Hello", notes[0].Title)
	assert.Equal(t, "World", notes[0].Content)
}

func TestImportJotJSONInvalidFormat(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotimport2", "password123", false)

	t.Run("wrong format marker", func(t *testing.T) {
		payload := `{"format":"google_keep","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":[]}`
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("unsupported version", func(t *testing.T) {
		payload := `{"format":"jot_export","version":99,"exported_at":"2026-01-01T00:00:00Z","notes":[]}`
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("notes is null", func(t *testing.T) {
		payload := `{"format":"jot_export","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":null}`
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("not valid JSON", func(t *testing.T) {
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte("not json")))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("google keep data with jot_json type", func(t *testing.T) {
		data := marshalKeepNote(t, keepNoteJSON{Title: "Keep Note", TextContent: "content"})
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(data))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}

func TestImportJotJSONValidation(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotimportval", "password123", false)

	makePayload := func(noteJSON string) []byte {
		return []byte(`{"format":"jot_export","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":[` + noteJSON + `]}`)
	}

	t.Run("unsupported note_type returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"drawing","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("title too long returns 400", func(t *testing.T) {
		longTitle, _ := json.Marshal(strings.Repeat("a", 201))
		payload := makePayload(`{"title":` + string(longTitle) + `,"content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("content too long returns 400", func(t *testing.T) {
		longContent, _ := json.Marshal(strings.Repeat("a", 10001))
		payload := makePayload(`{"title":"X","content":` + string(longContent) + `,"note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("invalid color returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"text","color":"notacolor","pinned":false,"archived":false,"position":0,"labels":[]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("text note with items returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[],"items":[{"text":"item","completed":false,"position":0,"indent_level":0}]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("item text too long returns 400", func(t *testing.T) {
		longItem, _ := json.Marshal(strings.Repeat("a", 501))
		payload := makePayload(`{"title":"X","content":"","note_type":"todo","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[],"items":[{"text":` + string(longItem) + `,"completed":false,"position":0,"indent_level":0}]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})

	t.Run("invalid indent_level returns 400", func(t *testing.T) {
		payload := makePayload(`{"title":"X","content":"","note_type":"todo","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[],"items":[{"text":"item","completed":false,"position":0,"indent_level":5}]}`)
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(payload))
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	})
}

func TestImportJotJSONRoundTrip(t *testing.T) {
	ts := setupTestServer(t)
	src := ts.createTestUser(t, "roundtripsrc", "password123", false)
	dst := ts.createTestUser(t, "roundtripdst", "password123", false)

	// Create a variety of notes for the source user.
	pinned := true
	archived := true
	srcPinned, err := src.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:   "Pinned Note",
		Content: "pinned content",
		Color:   "#fbbc04",
	})
	require.NoError(t, err)
	_, err = src.Client.UpdateNote(t.Context(), srcPinned.ID, &client.UpdateNoteRequest{Pinned: &pinned})
	require.NoError(t, err)

	srcArchived, err := src.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:   "Archived Note",
		Content: "archived content",
	})
	require.NoError(t, err)
	_, err = src.Client.UpdateNote(t.Context(), srcArchived.ID, &client.UpdateNoteRequest{Archived: &archived})
	require.NoError(t, err)

	collapsed := true
	srcTodo, err := src.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:    "Todo Note",
		NoteType: client.NoteTypeTodo,
		Items: []client.CreateNoteItem{
			{Text: "Item 1", Position: 0, IndentLevel: 0, Completed: true},
			{Text: "Item 2", Position: 1, IndentLevel: 1, Completed: false},
		},
	})
	require.NoError(t, err)
	_, err = src.Client.UpdateNote(t.Context(), srcTodo.ID, &client.UpdateNoteRequest{CheckedItemsCollapsed: &collapsed})
	require.NoError(t, err)

	// Create a label and attach it.
	_, err = src.Client.CreateLabel(t.Context(), "work")
	require.NoError(t, err)
	srcLabeled, err := src.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
		Title:  "Labeled Note",
		Labels: []string{"work"},
	})
	require.NoError(t, err)
	_ = srcLabeled

	// Export source user's notes.
	export, err := src.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "jot_export", export.Format)
	assert.Equal(t, 1, export.Version)
	assert.Len(t, export.Notes, 4)

	// Marshal export for import.
	exportData, err := json.Marshal(export)
	require.NoError(t, err)

	// Import into fresh destination user.
	result, err := dst.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader(exportData))
	require.NoError(t, err)
	assert.Equal(t, 4, result.Imported)
	assert.Equal(t, 0, result.Skipped)
	assert.Empty(t, result.Errors)

	// Verify imported notes.
	activeNotes, err := dst.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	archivedNotes, err := dst.Client.ListNotes(t.Context(), &client.ListNotesOptions{Archived: true})
	require.NoError(t, err)

	allNotes := make([]client.Note, 0, len(activeNotes)+len(archivedNotes))
	allNotes = append(allNotes, activeNotes...)
	allNotes = append(allNotes, archivedNotes...)
	assert.Len(t, allNotes, 4)

	byTitle := map[string]client.Note{}
	for _, n := range allNotes {
		byTitle[n.Title] = n
	}

	// Pinned note.
	pn, ok := byTitle["Pinned Note"]
	require.True(t, ok)
	assert.True(t, pn.Pinned)
	assert.Equal(t, "#fbbc04", pn.Color)

	// Archived note.
	an, ok := byTitle["Archived Note"]
	require.True(t, ok)
	assert.True(t, an.Archived)

	// Todo note with items.
	tn, ok := byTitle["Todo Note"]
	require.True(t, ok)
	assert.Equal(t, client.NoteTypeTodo, tn.NoteType)
	assert.True(t, tn.CheckedItemsCollapsed)
	require.Len(t, tn.Items, 2)
	itemsByPos := map[int]client.NoteItem{}
	for _, item := range tn.Items {
		itemsByPos[item.Position] = item
	}
	assert.Equal(t, "Item 1", itemsByPos[0].Text)
	assert.True(t, itemsByPos[0].Completed)
	assert.Equal(t, 0, itemsByPos[0].IndentLevel)
	assert.Equal(t, "Item 2", itemsByPos[1].Text)
	assert.False(t, itemsByPos[1].Completed)
	assert.Equal(t, 1, itemsByPos[1].IndentLevel)

	// Labeled note.
	ln, ok := byTitle["Labeled Note"]
	require.True(t, ok)
	require.Len(t, ln.Labels, 1)
	assert.Equal(t, "work", ln.Labels[0].Name)
}

func TestImportJotJSONDuplicateImport(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotduplicate", "password123", false)

	payload := `{"format":"jot_export","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":[{"title":"Dup","content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":[]}]}`

	result1, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
	require.NoError(t, err)
	assert.Equal(t, 1, result1.Imported)

	result2, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
	require.NoError(t, err)
	assert.Equal(t, 1, result2.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	assert.Len(t, notes, 2, "duplicate import should create two distinct notes")
}

func TestImportJotJSONLabelsDeduplication(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotlabeldedupe", "password123", false)

	payload := `{"format":"jot_export","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":[{"title":"N","content":"","note_type":"text","color":"#ffffff","pinned":false,"archived":false,"position":0,"labels":["work","work","  work  "]}]}`

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Len(t, notes[0].Labels, 1, "duplicate label names should be deduplicated")
	assert.Equal(t, "work", notes[0].Labels[0].Name)
}

func TestImportJotJSONEmptyColor(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "jotcolordefault", "password123", false)

	// Omitting color field should default to #ffffff.
	payload := `{"format":"jot_export","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":[{"title":"No Color","content":"","note_type":"text","pinned":false,"archived":false,"position":0,"labels":[]}]}`

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", bytes.NewReader([]byte(payload)))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)

	notes, err := user.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, "#ffffff", notes[0].Color)
}
