package models

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOrderItemsParentsFirst(t *testing.T) {
	ptr := func(s string) *string { return &s }

	t.Run("orders parent before child even when child has a lower position", func(t *testing.T) {
		parent := NoteItem{ID: "parent", Position: 5}
		child := NoteItem{ID: "child", Position: 1, ParentID: ptr("parent")}

		ordered := orderItemsParentsFirst([]NoteItem{child, parent})

		require.Len(t, ordered, 2)
		assert.Equal(t, "parent", ordered[0].ID)
		assert.Equal(t, "child", ordered[1].ID)
	})

	t.Run("keeps ascending position order within the same depth", func(t *testing.T) {
		ordered := orderItemsParentsFirst([]NoteItem{
			{ID: "a", Position: 2},
			{ID: "b", Position: 0},
			{ID: "c", Position: 1},
		})

		assert.Equal(t, []string{"b", "c", "a"},
			[]string{ordered[0].ID, ordered[1].ID, ordered[2].ID})
	})

	t.Run("treats an item whose parent is outside the set as a root", func(t *testing.T) {
		ordered := orderItemsParentsFirst([]NoteItem{
			{ID: "orphan", Position: 0, ParentID: ptr("missing")},
		})

		require.Len(t, ordered, 1)
		assert.Equal(t, "orphan", ordered[0].ID)
	})

	t.Run("does not loop on a parent cycle", func(t *testing.T) {
		ordered := orderItemsParentsFirst([]NoteItem{
			{ID: "x", ParentID: ptr("y")},
			{ID: "y", ParentID: ptr("x")},
		})

		assert.Len(t, ordered, 2)
	})
}

func TestIsValidID(t *testing.T) {
	t.Run("valid ID with 22 characters", func(t *testing.T) {
		validID := "abcdefghijklmnopqrstuv"
		assert.True(t, IsValidID(validID))
	})

	t.Run("valid ID with mixed case and numbers", func(t *testing.T) {
		validID := "0123456789abcdefABCDEF"
		assert.True(t, IsValidID(validID))
	})

	t.Run("invalid ID with wrong length - too short", func(t *testing.T) {
		shortID := "abc123"
		assert.False(t, IsValidID(shortID))
	})

	t.Run("invalid ID with 21 characters - boundary test", func(t *testing.T) {
		id21Chars := "abcdefghijklmnopqrstu"
		assert.False(t, IsValidID(id21Chars))
	})

	t.Run("invalid ID with 23 characters - boundary test", func(t *testing.T) {
		id23Chars := "abcdefghijklmnopqrstuvw"
		assert.False(t, IsValidID(id23Chars))
	})

	t.Run("invalid ID with wrong length - too long", func(t *testing.T) {
		longID := "abcdefghijklmnopqrstuvwxyz"
		assert.False(t, IsValidID(longID))
	})

	t.Run("invalid ID with special characters", func(t *testing.T) {
		invalidID := "abcdefghijklmnopqrst!@"
		assert.False(t, IsValidID(invalidID))
	})

	t.Run("invalid ID with unicode characters", func(t *testing.T) {
		invalidID := "abcdefghijklmnopqrst🔥"
		assert.False(t, IsValidID(invalidID))
	})

	t.Run("empty string", func(t *testing.T) {
		assert.False(t, IsValidID(""))
	})
}
