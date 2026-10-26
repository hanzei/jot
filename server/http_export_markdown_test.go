package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExportMarkdown(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportmarkdown", "password123", false)
	other := ts.createTestUser(t, "exportmarkdownother", "password123", false)

	text, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
		Content: "# Meeting: Q3?\n\nSome **notes**",
		Color:   "#fbbc04",
		Labels:  []string{"Work stuff"},
		Pinned:  true,
	})
	require.NoError(t, err)
	_, err = user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "Groceries",
		Items: []client.CreateNoteItem{
			{Text: "Fruit", Position: 0},
			{Text: "Apples", Position: 1, IndentLevel: 1, Completed: true},
			{Text: "Milk", Position: 2},
		},
	})
	require.NoError(t, err)
	// Two notes that slugify alike, and one named after a Windows device.
	_, err = user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "groceries"})
	require.NoError(t, err)
	_, err = user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "CON"})
	require.NoError(t, err)
	// Notes of other users stay out.
	_, err = other.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "Not mine"})
	require.NoError(t, err)

	img := testPNG(t, 8, 8)
	_, err = user.Client.UploadNoteImage(t.Context(), text.ID, "diagram.png", bytes.NewReader(img))
	require.NoError(t, err)

	data, err := user.Client.ExportNotesMarkdown(t.Context())
	require.NoError(t, err)
	entries := bundleEntries(t, data)

	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sum := sha256.Sum256(img)
	imageEntry := "images/" + hex.EncodeToString(sum[:]) + ".png"
	assert.ElementsMatch(t, []string{
		"notes/meeting-q3.md",
		"notes/groceries.md",
		"notes/groceries-2.md",
		"notes/con-note.md",
		imageEntry,
	}, names)
	assert.Equal(t, img, entries[imageEntry])

	meeting := string(entries["notes/meeting-q3.md"])
	assert.True(t, strings.HasPrefix(meeting, "---\ntags:\n  - \"Work-stuff\"\ncolor: \"#fbbc04\"\npinned: true\narchived: false\njot_type: \"text\"\ncreated: "), meeting)
	assert.Contains(t, meeting, "\n---\n\n# Meeting: Q3?\n\nSome **notes**\n\n![diagram.png](../"+imageEntry+")\n")

	// Which of the two colliding notes gets the plain slug depends on note
	// order; one of them is the list note.
	groceries := string(entries["notes/groceries.md"])
	if !strings.Contains(groceries, "jot_type: \"list\"") {
		groceries = string(entries["notes/groceries-2.md"])
	}
	assert.Contains(t, groceries, "tags: []\n")
	assert.Contains(t, groceries, "jot_type: \"list\"\n")
	assert.Contains(t, groceries, "\n---\n\n# Groceries\n\n- [ ] Fruit\n  - [x] Apples\n- [ ] Milk\n")
}

func TestExportMarkdownResponseHeaders(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportmdheaders", "password123", false)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/export?format=markdown", nil)
	require.NoError(t, err)
	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "application/zip", resp.Header.Get("Content-Type"))
	assert.Contains(t, resp.Header.Get("Content-Disposition"), "jot-markdown-export-")
}

func TestExportFormat(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportformat", "password123", false)

	for _, tc := range []struct {
		format string
		status int
	}{
		{"jot", http.StatusOK},
		{"markdown", http.StatusOK},
		{"html", http.StatusBadRequest},
	} {
		t.Run(tc.format, func(t *testing.T) {
			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/notes/export?format="+tc.format, nil)
			require.NoError(t, err)
			resp, err := user.Client.HTTPClient().Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()
			assert.Equal(t, tc.status, resp.StatusCode)
		})
	}
}
