package client

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateNoteRejectsExplicitEmptyItemsSlice(t *testing.T) {
	c := New("http://example.com")
	req := &UpdateNoteRequest{
		Items: []UpdateNoteItem{},
	}

	note, err := c.UpdateNote(t.Context(), "note-id", req)
	require.Error(t, err)
	assert.Nil(t, note)
	assert.Contains(t, err.Error(), "cannot be an empty slice")
	assert.Contains(t, err.Error(), "raw HTTP PATCH")
}
