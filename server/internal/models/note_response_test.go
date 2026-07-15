package models

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewNoteResponseTextNote proves a text note's JSON has no items or
// checked_items_collapsed key at all — not merely a zero-valued one — and
// that content is present even when empty.
func TestNewNoteResponseTextNote(t *testing.T) {
	n := Note{
		ID:        "textnote0000000000000",
		UserID:    "user000000000000000000",
		Content:   "hello",
		NoteType:  NoteTypeText,
		Labels:    []Label{},
		DeletedAt: nil,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	data, err := json.Marshal(NewNoteResponse(n))
	require.NoError(t, err)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(data, &raw))

	assert.Equal(t, "hello", raw["content"])
	assert.NotContains(t, raw, "title")
	assert.NotContains(t, raw, "items")
	assert.NotContains(t, raw, "checked_items_collapsed")

	// An empty-content text note still emits "content":"" — the key is
	// present because content is owned by this variant, only the value
	// happens to be zero.
	empty := n
	empty.Content = ""
	data, err = json.Marshal(NewNoteResponse(empty))
	require.NoError(t, err)
	raw = nil
	require.NoError(t, json.Unmarshal(data, &raw))
	assert.Empty(t, raw["content"])
	assert.Contains(t, raw, "content")
}

// TestNewNoteResponseListNote proves a list note's JSON has no content key at
// all, while title, items, and checked_items_collapsed are always present —
// even when empty/false — because they are legitimately owned by every list
// note.
func TestNewNoteResponseListNote(t *testing.T) {
	n := Note{
		ID:                    "listnote0000000000000",
		UserID:                "user000000000000000000",
		Title:                 "",
		NoteType:              NoteTypeList,
		CheckedItemsCollapsed: false,
		Items:                 nil,
		Labels:                []Label{},
		CreatedAt:             time.Now(),
		UpdatedAt:             time.Now(),
	}

	data, err := json.Marshal(NewNoteResponse(n))
	require.NoError(t, err)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(data, &raw))

	assert.NotContains(t, raw, "content")
	assert.Contains(t, raw, "title")
	assert.Empty(t, raw["title"])
	assert.Contains(t, raw, "checked_items_collapsed")
	assert.Equal(t, false, raw["checked_items_collapsed"])
	// A list note with zero items still emits "items":[], never a bare
	// omitted key or a JSON null.
	require.Contains(t, raw, "items")
	items, ok := raw["items"].([]any)
	require.True(t, ok, "items must serialize as a JSON array, not null")
	assert.Empty(t, items)
}

func TestNewNoteResponses(t *testing.T) {
	notes := []*Note{
		{ID: "a", NoteType: NoteTypeText, Content: "text"},
		{ID: "b", NoteType: NoteTypeList, Title: "list"},
	}

	responses := NewNoteResponses(notes)
	require.Len(t, responses, 2)

	textResp, ok := responses[0].(TextNoteResponse)
	require.True(t, ok)
	assert.Equal(t, "text", textResp.Content)

	listResp, ok := responses[1].(ListNoteResponse)
	require.True(t, ok)
	assert.Equal(t, "list", listResp.Title)
}
