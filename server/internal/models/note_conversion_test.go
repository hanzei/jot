package models

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseTextLineAsListItem(t *testing.T) {
	t.Run("drops blank lines", func(t *testing.T) {
		_, ok := ParseTextLineAsListItem("")
		assert.False(t, ok)
		_, ok = ParseTextLineAsListItem("   ")
		assert.False(t, ok)
	})

	t.Run("strips heading markdown", func(t *testing.T) {
		item, ok := ParseTextLineAsListItem("# Groceries")
		require.True(t, ok)
		assert.Equal(t, ConvertedListItem{Text: "Groceries", Completed: false}, item)

		item, ok = ParseTextLineAsListItem("### Sub heading")
		require.True(t, ok)
		assert.Equal(t, "Sub heading", item.Text)
	})

	t.Run("strips bold and italic markdown", func(t *testing.T) {
		item, ok := ParseTextLineAsListItem("**Buy** milk")
		require.True(t, ok)
		assert.Equal(t, "Buy milk", item.Text)

		item, ok = ParseTextLineAsListItem("__Buy__ milk")
		require.True(t, ok)
		assert.Equal(t, "Buy milk", item.Text)

		item, ok = ParseTextLineAsListItem("*Buy* milk")
		require.True(t, ok)
		assert.Equal(t, "Buy milk", item.Text)
	})

	t.Run("strips inline code and links", func(t *testing.T) {
		item, ok := ParseTextLineAsListItem("Run `npm test`")
		require.True(t, ok)
		assert.Equal(t, "Run npm test", item.Text)

		item, ok = ParseTextLineAsListItem("See [docs](https://example.com)")
		require.True(t, ok)
		assert.Equal(t, "See docs", item.Text)
	})

	t.Run("strips blockquote markers", func(t *testing.T) {
		item, ok := ParseTextLineAsListItem("> Remember this")
		require.True(t, ok)
		assert.Equal(t, "Remember this", item.Text)
	})

	t.Run("strips a leading list marker without setting completed", func(t *testing.T) {
		for _, line := range []string{"- Buy milk", "* Buy milk", "1. Buy milk"} {
			item, ok := ParseTextLineAsListItem(line)
			require.True(t, ok, line)
			assert.Equal(t, ConvertedListItem{Text: "Buy milk", Completed: false}, item, line)
		}
	})

	t.Run("recognizes a checkbox marker and sets completed", func(t *testing.T) {
		item, ok := ParseTextLineAsListItem("- [x] Buy milk")
		require.True(t, ok)
		assert.Equal(t, ConvertedListItem{Text: "Buy milk", Completed: true}, item)

		item, ok = ParseTextLineAsListItem("- [X] Buy milk")
		require.True(t, ok)
		assert.True(t, item.Completed)

		item, ok = ParseTextLineAsListItem("- [ ] Buy milk")
		require.True(t, ok)
		assert.False(t, item.Completed)
	})

	t.Run("combines marker stripping with inline formatting", func(t *testing.T) {
		item, ok := ParseTextLineAsListItem("- [x] **Buy** `milk`")
		require.True(t, ok)
		assert.Equal(t, ConvertedListItem{Text: "Buy milk", Completed: true}, item)
	})
}

func TestTextToListItems(t *testing.T) {
	t.Run("converts each non-blank line to an item, dropping blank lines", func(t *testing.T) {
		content := "# Groceries\n\n- [x] Milk\n- Eggs\n\n**Bread**"
		items := TextToListItems(content)
		require.Len(t, items, 4)
		assert.Equal(t, []ConvertedListItem{
			{Text: "Groceries", Completed: false},
			{Text: "Milk", Completed: true},
			{Text: "Eggs", Completed: false},
			{Text: "Bread", Completed: false},
		}, items)
	})

	t.Run("returns no items for blank content", func(t *testing.T) {
		assert.Empty(t, TextToListItems("   \n\n  "))
	})
}

func TestListToText(t *testing.T) {
	ptr := func(s string) *string { return &s }

	t.Run("renders the title as an h1 line followed by a blank line", func(t *testing.T) {
		items := []NoteItem{{ID: "1", Text: "Milk", Position: 0}}
		assert.Equal(t, "# Groceries\n\n- [ ] Milk", ListToText("Groceries", items))
	})

	t.Run("omits the heading entirely when there is no title", func(t *testing.T) {
		items := []NoteItem{{ID: "1", Text: "Milk", Position: 0}}
		assert.Equal(t, "- [ ] Milk", ListToText("", items))
	})

	t.Run("renders completed items with a checked box", func(t *testing.T) {
		items := []NoteItem{{ID: "1", Text: "Milk", Completed: true, Position: 0}}
		assert.Equal(t, "- [x] Milk", ListToText("", items))
	})

	t.Run("orders top-level items by position and indents nested children under their parent", func(t *testing.T) {
		items := []NoteItem{
			{ID: "p2", Text: "Second parent", Position: 1},
			{ID: "p1", Text: "First parent", Position: 0},
			{ID: "c1", Text: "Child of first", Position: 0, ParentID: ptr("p1")},
			{ID: "c2", Text: "Another child of first", Position: 1, ParentID: ptr("p1")},
		}
		assert.Equal(t,
			"- [ ] First parent\n  - [ ] Child of first\n  - [ ] Another child of first\n- [ ] Second parent",
			ListToText("", items),
		)
	})
}
