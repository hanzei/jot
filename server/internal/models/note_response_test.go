package models

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewNoteResponse proves each variant's JSON has no key at all for the
// fields the other variant owns — not merely a zero-valued one — while the
// fields it does own are always present, even when empty/zero.
func TestNewNoteResponse(t *testing.T) {
	t.Run("text note", func(t *testing.T) {
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

		data, err := json.Marshal(NewNoteResponse(t.Context(), n))
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
		data, err = json.Marshal(NewNoteResponse(t.Context(), empty))
		require.NoError(t, err)
		raw = nil
		require.NoError(t, json.Unmarshal(data, &raw))
		assert.Empty(t, raw["content"])
		assert.Contains(t, raw, "content")
	})

	t.Run("list note", func(t *testing.T) {
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

		data, err := json.Marshal(NewNoteResponse(t.Context(), n))
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
	})
}

func TestNewNoteResponses(t *testing.T) {
	notes := []*Note{
		{ID: "a", NoteType: NoteTypeText, Content: "text"},
		{ID: "b", NoteType: NoteTypeList, Title: "list"},
	}

	responses := NewNoteResponses(t.Context(), notes)
	require.Len(t, responses, 2)

	textResp, ok := responses[0].(TextNoteResponse)
	require.True(t, ok)
	assert.Equal(t, "text", textResp.Content)

	listResp, ok := responses[1].(ListNoteResponse)
	require.True(t, ok)
	assert.Equal(t, "list", listResp.Title)
}
