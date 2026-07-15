package client

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNoteMarshalTextNote proves a text Note round-trips through JSON without
// ever reintroducing the flattened shape the server stopped sending: the
// wire form has no items/checked_items_collapsed/title keys, and decoding it
// back leaves List nil.
func TestNoteMarshalTextNote(t *testing.T) {
	n := Note{
		ID:       "textnote0000000000000",
		NoteType: NoteTypeText,
		Labels:   []Label{},
		Text:     &TextNoteFields{Content: "hello"},
	}

	data, err := json.Marshal(&n)
	require.NoError(t, err)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(data, &raw))
	assert.Equal(t, "hello", raw["content"])
	assert.NotContains(t, raw, "title")
	assert.NotContains(t, raw, "items")
	assert.NotContains(t, raw, "checked_items_collapsed")

	var decoded Note
	require.NoError(t, json.Unmarshal(data, &decoded))
	require.NotNil(t, decoded.Text)
	assert.Equal(t, "hello", decoded.Text.Content)
	assert.Nil(t, decoded.List)
}

// TestNoteMarshalListNote proves a list Note round-trips with no content key,
// and that title/items/checked_items_collapsed survive even when zero-valued.
func TestNoteMarshalListNote(t *testing.T) {
	n := Note{
		ID:       "listnote0000000000000",
		NoteType: NoteTypeList,
		Labels:   []Label{},
		List:     &ListNoteFields{Title: "", Items: nil, CheckedItemsCollapsed: false},
	}

	data, err := json.Marshal(&n)
	require.NoError(t, err)

	var raw map[string]any
	require.NoError(t, json.Unmarshal(data, &raw))
	assert.NotContains(t, raw, "content")
	assert.Contains(t, raw, "title")
	assert.Contains(t, raw, "checked_items_collapsed")
	assert.Contains(t, raw, "items")

	var decoded Note
	require.NoError(t, json.Unmarshal(data, &decoded))
	require.NotNil(t, decoded.List)
	assert.Empty(t, decoded.List.Title)
	assert.False(t, decoded.List.CheckedItemsCollapsed)
	assert.Nil(t, decoded.Text)
}

func TestNoteMarshalMissingVariantFieldsErrors(t *testing.T) {
	_, err := json.Marshal(&Note{NoteType: NoteTypeText})
	require.Error(t, err)

	_, err = json.Marshal(&Note{NoteType: NoteTypeList})
	require.Error(t, err)
}
