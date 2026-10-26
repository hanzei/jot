package handlers

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestListToMarkdownSharedFixture runs listToMarkdown against the fixture
// listToText in shared/src/noteConversion.ts is also tested with, so the
// export and the clients agree on how a list note reads as Markdown.
func TestListToMarkdownSharedFixture(t *testing.T) {
	t.Parallel()

	data, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "src", "listToMarkdownCases.json"))
	require.NoError(t, err)
	var cases []struct {
		ID          string            `json:"id"`
		Description string            `json:"description"`
		Title       string            `json:"title"`
		Items       []models.NoteItem `json:"items"`
		Markdown    string            `json:"markdown"`
	}
	require.NoError(t, json.Unmarshal(data, &cases, json.RejectUnknownMembers(true)))
	require.NotEmpty(t, cases)

	for _, c := range cases {
		t.Run(c.ID, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, c.Markdown, listToMarkdown(c.Title, c.Items), c.Description)
		})
	}
}

func TestMarkdownSlug(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"lower-cases and hyphenates", "Shopping List", "shopping-list"},
		{"drops windows-unsafe characters", `a:b?c*d"e<f>g|h/i\j`, "a-b-c-d-e-f-g-h-i-j"},
		{"drops trailing dots and spaces", "Notes... ", "notes"},
		{"collapses punctuation runs", "--Hello,   World!--", "hello-world"},
		{"keeps non-latin letters", "Café Über 日本", "café-über-日本"},
		{"empty when nothing is left", "?!.", ""},
		{"a separator never pushes it past the cap", strings.Repeat("a", 59) + " b", strings.Repeat("a", 59)},
		{"caps the length", "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggg", "aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd-eeeeeeeeee-fffff"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, markdownSlug(tt.in))
		})
	}
}

func TestMarkdownNoteSlug(t *testing.T) {
	t.Parallel()

	parent := "p"
	tests := []struct {
		name string
		note *models.Note
		want string
	}{
		{"text note uses its first line", &models.Note{NoteType: models.NoteTypeText, Content: "\n\n  Meeting notes\nbody"}, "meeting-notes"},
		{"text note strips a heading marker", &models.Note{NoteType: models.NoteTypeText, Content: "## 2024 Plans\nbody"}, "2024-plans"},
		{"empty text note", &models.Note{NoteType: models.NoteTypeText}, "untitled"},
		{"list note uses its title", &models.Note{NoteType: models.NoteTypeList, Title: "Groceries"}, "groceries"},
		{
			"untitled list note uses its first top-level item",
			&models.Note{NoteType: models.NoteTypeList, Items: []models.NoteItem{
				{ID: "c", Text: "Child", Position: 0, ParentID: &parent},
				{ID: "q", Text: "Second", Position: 1},
				{ID: "p", Text: "First", Position: 0},
			}},
			"first",
		},
		{"empty list note", &models.Note{NoteType: models.NoteTypeList}, "untitled"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, markdownNoteSlug(tt.note))
		})
	}
}

func TestMarkdownTags(t *testing.T) {
	t.Parallel()

	labels := []models.Label{
		{Name: "Work stuff"},
		{Name: "#urgent"},
		{Name: "work  stuff"},
		{Name: `a"b: c`},
		{Name: "Projects/Jot"},
		{Name: "C++"},
		{Name: "日本 語"},
		{Name: "?!"},
	}
	assert.Equal(t, []string{"Work-stuff", "urgent", "a-b-c", "Projects/Jot", "C", "日本-語"}, markdownTags(labels))
}

func TestUniqueMarkdownSlug(t *testing.T) {
	t.Parallel()

	used := make(map[string]bool)
	assert.Equal(t, "notes", uniqueMarkdownSlug("notes", used))
	assert.Equal(t, "notes-2", uniqueMarkdownSlug("notes", used))
	assert.Equal(t, "notes-3", uniqueMarkdownSlug("notes", used))
	// A slug that happens to look like a suffixed one still gets its own name.
	assert.Equal(t, "notes-2-2", uniqueMarkdownSlug("notes-2", used))
	assert.Equal(t, "con-note", uniqueMarkdownSlug("con", used))
	assert.Equal(t, "lpt1-note", uniqueMarkdownSlug("lpt1", used))
	assert.Equal(t, "con-note-2", uniqueMarkdownSlug("con", used))
}

func TestMarkdownNoteFile(t *testing.T) {
	t.Parallel()

	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	updated := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)

	t.Run("text note", func(t *testing.T) {
		t.Parallel()
		n := &models.Note{
			NoteType:  models.NoteTypeText,
			Content:   "# Ideas\n\nSome *thoughts*\n\n",
			Color:     "#fbbc04",
			Pinned:    true,
			Labels:    []models.Label{{Name: "Work stuff"}, {Name: "#urgent"}, {Name: "work  stuff"}},
			CreatedAt: created,
			UpdatedAt: updated,
		}
		images := []jotExportImage{{File: "images/abc.png", Filename: "shot [1].png"}}
		assert.Equal(t, `---
tags:
  - "Work-stuff"
  - "urgent"
color: "#fbbc04"
pinned: true
archived: false
jot_type: "text"
created: 2026-01-02T03:04:05Z
updated: 2026-02-03T04:05:06Z
---

# Ideas

Some *thoughts*

![shot \[1\].png](../images/abc.png)
`, markdownNoteFile(n, images))
	})

	t.Run("list note without labels", func(t *testing.T) {
		t.Parallel()
		n := &models.Note{
			NoteType: models.NoteTypeList,
			Title:    "Groceries",
			Color:    "#ffffff",
			Archived: true,
			Items: []models.NoteItem{
				{ID: "a", Text: "Milk", Position: 0},
				{ID: "b", Text: "Eggs", Completed: true, Position: 1},
			},
			CreatedAt: created,
			UpdatedAt: updated,
		}
		assert.Equal(t, `---
tags: []
color: "#ffffff"
pinned: false
archived: true
jot_type: "list"
created: 2026-01-02T03:04:05Z
updated: 2026-02-03T04:05:06Z
---

# Groceries

- [ ] Milk
- [x] Eggs
`, markdownNoteFile(n, nil))
	})

	t.Run("front-matter values are quoted", func(t *testing.T) {
		t.Parallel()
		n := &models.Note{NoteType: models.NoteTypeText, Color: "a\"b: c", CreatedAt: created, UpdatedAt: updated}
		assert.Contains(t, markdownNoteFile(n, nil), "color: \"a\\\"b: c\"\n")
	})
}
