package models

import (
	"context"
	"testing"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestSearchStore opens a fresh migrated database for driver and returns a
// noteStore bound to it plus an owning user ID.
func newTestSearchStore(t *testing.T, driver string) (*noteStore, string) {
	t.Helper()

	db := dbtest.New(t, driver)
	d := &dialect.Dialect{Driver: driver}
	store := newNoteStore(db, d)

	_, err := db.ExecContext(t.Context(),
		d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
		"user000000000000000srch", "searcher", "x")
	require.NoError(t, err)

	return store, "user000000000000000srch"
}

// searchIDs runs an active-notes search and returns the matching note IDs in
// result order.
func searchIDs(t *testing.T, store *noteStore, ctx context.Context, userID, query string) []string {
	t.Helper()
	notes, err := store.GetByUserID(ctx, userID, false, false, query, "", false)
	require.NoError(t, err)
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	return ids
}

func TestBuildSearchTokens(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"single word", "hello", []string{"hello"}},
		{"lowercases", "Hello WORLD", []string{"hello", "world"}},
		{"lowercases non-ASCII", "CAFÉ München", []string{"café", "münchen"}},
		{"splits on punctuation and operators", `foo, bar-baz: qux`, []string{"foo", "bar", "baz", "qux"}},
		{"treats metacharacters as separators", `100% "foo" *bar -baz &`, []string{"100", "foo", "bar", "baz"}},
		{"underscore is a separator", "foo_bar", []string{"foo", "bar"}},
		{"keeps digits", "note 42", []string{"note", "42"}},
		{"empty input", "", []string{}},
		{"punctuation only yields nothing", `%_"*:&-`, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, buildSearchTokens(tc.in))
		})
	}
}

func TestNoteSearch(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("matches a single word in title or content", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			byTitle, err := store.Create(ctx, userID, "", "Weekend plans", "", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			byContent, err := store.Create(ctx, userID, "", "Untitled", "buy some groceries", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			_, err = store.Create(ctx, userID, "", "Unrelated", "nothing here", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)

			assert.ElementsMatch(t, []string{byTitle.ID}, searchIDs(t, store, ctx, userID, "weekend"))
			assert.ElementsMatch(t, []string{byContent.ID}, searchIDs(t, store, ctx, userID, "groceries"))
		})

		t.Run("multi-word query ANDs terms across title and list items", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			// "weekend" is the title; "groceries" is a list item. A single-row
			// LIKE could never match this; the aggregated index does.
			match, err := store.CreateWithItems(ctx, userID, "", "Weekend", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{Text: "buy groceries", Position: 0}, {Text: "clean garage", Position: 1}})
			require.NoError(t, err)
			// Has "weekend" but not "groceries".
			_, err = store.Create(ctx, userID, "", "Weekend", "relax", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)

			assert.ElementsMatch(t, []string{match.ID}, searchIDs(t, store, ctx, userID, "weekend groceries"))
			// Term order is irrelevant.
			assert.ElementsMatch(t, []string{match.ID}, searchIDs(t, store, ctx, userID, "groceries weekend"))
			// A word present in neither field excludes the note.
			assert.Empty(t, searchIDs(t, store, ctx, userID, "weekend missing"))
		})

		t.Run("prefix-matches the last term for search-as-you-type", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.Create(ctx, userID, "", "Saturday market", "", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)

			for _, q := range []string{"satu", "saturd", "market satu"} {
				assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, q), "query %q", q)
			}
			// Only the last term is a prefix: a non-final partial word must not match.
			assert.Empty(t, searchIDs(t, store, ctx, userID, "satu market"))
		})

		t.Run("is case-insensitive including non-ASCII", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.Create(ctx, userID, "", "Café au lait à München", "", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)

			for _, q := range []string{"café", "CAFÉ", "münchen", "MÜNCHEN"} {
				assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, q), "query %q", q)
			}
			// Diacritics are significant (matches both backends' tokenizers).
			assert.Empty(t, searchIDs(t, store, ctx, userID, "cafe"))
		})

		t.Run("treats query metacharacters as literal words without erroring", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.Create(ctx, userID, "", "Progress 100 percent", "foo bar baz", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)

			// Each of these historically-dangerous inputs must run without a 500
			// and be treated as literal words.
			for _, q := range []string{`100%`, `foo_bar`, `"foo"`, `foo*`, `-foo`, `foo:bar`, `foo & bar`, `100% foo`} {
				ids := searchIDs(t, store, ctx, userID, q)
				assert.NotNil(t, ids, "query %q should not error", q)
			}
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, `100%`))
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, `foo_bar`))
			// A query that tokenizes to nothing matches nothing (never everything).
			assert.Empty(t, searchIDs(t, store, ctx, userID, `%_"*:&`))
		})

		t.Run("orders by relevance with pinned notes first", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			// titleHit repeats the term in the title -> strongest relevance.
			titleHit, err := store.Create(ctx, userID, "", "mango mango", "fruit", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			// bodyHit mentions it once in content -> weaker.
			bodyHit, err := store.Create(ctx, userID, "", "Shopping", "one mango please", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			// pinnedWeak has the weakest match but is pinned, so it sorts first.
			pinnedWeak, err := store.Create(ctx, userID, "", "Reminder", "a mango", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			pin := true
			require.NoError(t, store.Update(ctx, pinnedWeak.ID, userID, nil, nil, nil, &pin, nil, nil, nil))

			ids := searchIDs(t, store, ctx, userID, "mango")
			require.Len(t, ids, 3)
			assert.Equal(t, pinnedWeak.ID, ids[0], "pinned note must come first")
			assert.Equal(t, titleHit.ID, ids[1], "stronger relevance before weaker among unpinned")
			assert.Equal(t, bodyHit.ID, ids[2])
		})
	})
}

// TestNoteSearchIndexConsistency exercises every write path that must keep the
// full-text index in sync.
func TestNoteSearchIndexConsistency(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		t.Run("edit note content updates the index", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.Create(ctx, userID, "", "Original", "alpha", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "alpha"))

			newContent := "beta gamma"
			require.NoError(t, store.Update(ctx, n.ID, userID, nil, &newContent, nil, nil, nil, nil, nil))
			assert.Empty(t, searchIDs(t, store, ctx, userID, "alpha"))
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "gamma"))
		})

		t.Run("add, edit and delete list items update the index", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.Create(ctx, userID, "", "List", "", NoteTypeList, DefaultNoteColor)
			require.NoError(t, err)

			item, err := store.CreateItemWithCompleted(ctx, n.ID, "artichoke", 0, false, "", "")
			require.NoError(t, err)
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "artichoke"))

			newText := "broccoli"
			_, err = store.PatchItem(ctx, n.ID, item.ID, NoteItemPatch{Text: &newText})
			require.NoError(t, err)
			assert.Empty(t, searchIDs(t, store, ctx, userID, "artichoke"))
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "broccoli"))

			require.NoError(t, store.DeleteItemFromNote(ctx, n.ID, item.ID))
			assert.Empty(t, searchIDs(t, store, ctx, userID, "broccoli"))
		})

		t.Run("duplicate indexes the copy", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			src, err := store.CreateWithItems(ctx, userID, "", "Recipe", "tasty", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{Text: "saffron", Position: 0}})
			require.NoError(t, err)
			full, err := store.GetByID(ctx, src.ID, userID)
			require.NoError(t, err)

			dup, err := store.Duplicate(ctx, full, userID, "", nil)
			require.NoError(t, err)
			// Both the original and the copy match the item term.
			assert.ElementsMatch(t, []string{src.ID, dup.ID}, searchIDs(t, store, ctx, userID, "saffron"))
		})

		t.Run("type conversion reindexes the new representation", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.CreateWithItems(ctx, userID, "", "Todo", "", NoteTypeList, DefaultNoteColor,
				[]NewNoteItem{{Text: "kayak", Position: 0}})
			require.NoError(t, err)
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "kayak"))

			// Convert to a text note whose content no longer has the item text.
			_, err = store.ConvertType(ctx, n.ID, userID, NoteTypeText, "", "sailing", nil, nil)
			require.NoError(t, err)
			assert.Empty(t, searchIDs(t, store, ctx, userID, "kayak"))
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "sailing"))
		})

		t.Run("import indexes imported notes and their items", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			require.NoError(t, store.ImportJotNotes(ctx, userID, []JotImportNote{{
				Title:    "Imported",
				NoteType: NoteTypeList,
				Color:    DefaultNoteColor,
				Items:    []JotImportNoteItem{{Text: "zucchini", Position: 0}},
			}}))
			ids := searchIDs(t, store, ctx, userID, "zucchini")
			require.Len(t, ids, 1)
		})

		t.Run("trash removes from active search; purge removes entirely", func(t *testing.T) {
			store, userID := newTestSearchStore(t, driver)
			ctx := t.Context()
			n, err := store.Create(ctx, userID, "", "Secret", "pineapple", NoteTypeText, DefaultNoteColor)
			require.NoError(t, err)
			assert.ElementsMatch(t, []string{n.ID}, searchIDs(t, store, ctx, userID, "pineapple"))

			require.NoError(t, store.MoveToTrash(ctx, n.ID, userID))
			// Gone from the active search...
			assert.Empty(t, searchIDs(t, store, ctx, userID, "pineapple"))
			// ...but still findable when searching the trash.
			trashed, err := store.GetByUserID(ctx, userID, false, true, "pineapple", "", false)
			require.NoError(t, err)
			require.Len(t, trashed, 1)
			assert.Equal(t, n.ID, trashed[0].ID)

			// Permanent delete drops it from the index for good.
			_, err = store.DeleteFromTrash(ctx, n.ID, userID)
			require.NoError(t, err)
			gone, err := store.GetByUserID(ctx, userID, false, true, "pineapple", "", false)
			require.NoError(t, err)
			assert.Empty(t, gone)
		})
	})
}
