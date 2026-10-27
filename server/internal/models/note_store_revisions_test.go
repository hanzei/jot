package models

import (
	"context"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	revisionOwnerID  = "user0000000000revowner"
	revisionCollabID = "user0000000000revcollb"
)

// newTestRevisionStore opens a fresh migrated database for driver with an
// owner and a collaborator user.
func newTestRevisionStore(t *testing.T, driver string) *noteStore {
	t.Helper()

	db := dbtest.New(t, driver)
	d := &dialect.Dialect{Driver: driver}
	store := newNoteStore(db, d)
	for _, u := range []struct{ id, name string }{{revisionOwnerID, "revowner"}, {revisionCollabID, "revcollab"}} {
		_, err := db.ExecContext(t.Context(),
			d.RewritePlaceholders(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
			u.id, u.name, "x")
		require.NoError(t, err)
	}
	return store
}

func createRevisionTextNote(t *testing.T, store *noteStore, content string) *Note {
	t.Helper()
	note, err := store.Create(t.Context(), revisionOwnerID, NewNote{Content: content, Type: NoteTypeText})
	require.NoError(t, err)
	return note
}

// createRevisionListNote creates a list note titled "groceries" with items
// "milk" and "eggs", shared with the collaborator.
func createRevisionListNote(t *testing.T, store *noteStore) *Note {
	t.Helper()
	note, err := store.CreateWithItems(t.Context(), revisionOwnerID, NewNote{Title: "groceries", Type: NoteTypeList}, []NewNoteItem{
		{Text: "milk", Position: 0},
		{Text: "eggs", Position: 1},
	})
	require.NoError(t, err)
	require.NoError(t, store.ShareNote(t.Context(), note.ID, revisionOwnerID, revisionCollabID))
	return note
}

func listRevisions(t *testing.T, store *noteStore, noteID string) []NoteRevisionSummary {
	t.Helper()
	revisions, err := store.ListRevisions(t.Context(), noteID, revisionOwnerID)
	require.NoError(t, err)
	return revisions
}

func latestRevision(t *testing.T, store *noteStore, noteID string) *NoteRevision {
	t.Helper()
	revisions := listRevisions(t, store, noteID)
	require.NotEmpty(t, revisions)
	rev, err := store.GetRevision(t.Context(), noteID, revisions[0].ID, revisionOwnerID)
	require.NoError(t, err)
	return rev
}

// ageRevisions moves every revision of the note back past the coalescing
// window, so the next write snapshots again.
func ageRevisions(t *testing.T, store *noteStore, noteID string) {
	t.Helper()
	_, err := store.db.ExecContext(t.Context(),
		store.d.RewritePlaceholders(`UPDATE note_revisions SET created_at = ? WHERE note_id = ?`),
		Timestamp(Now().Add(-2*NoteRevisionCoalesceWindow)), noteID)
	require.NoError(t, err)
}

func revisionItemTexts(items []NoteRevisionItem) []string {
	texts := make([]string, 0, len(items))
	for _, item := range items {
		texts = append(texts, item.Text)
	}
	return texts
}

func itemIDByText(t *testing.T, store *noteStore, noteID, text string) string {
	t.Helper()
	items, err := store.getItemsByNoteID(t.Context(), noteID)
	require.NoError(t, err)
	return bulkItemByText(t, items, text).ID
}

func TestNoteRevisionsRecordEveryContentWrite(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestRevisionStore(t, driver)

		t.Run("text edit", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "first draft")
			content := "second draft"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)

			rev := latestRevision(t, store, note.ID)
			assert.Equal(t, NoteTypeText, rev.NoteType)
			assert.Equal(t, "first draft", rev.Content)
			assert.Empty(t, rev.Items)
			assert.Nil(t, rev.ActorID, "a never-edited note's content has no recorded author")
		})

		t.Run("conversion", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "- [ ] milk")
			_, err := store.ConvertType(t.Context(), note.ID, revisionOwnerID, NoteTypeList, "", "", []NewNoteItem{{Text: "milk"}}, nil)
			require.NoError(t, err)

			rev := latestRevision(t, store, note.ID)
			assert.Equal(t, NoteTypeText, rev.NoteType)
			assert.Equal(t, "- [ ] milk", rev.Content)
		})

		// Each item write runs against a fresh list note; the revision must
		// hold the items as they were before it.
		itemWrites := map[string]func(t *testing.T, note *Note) error{
			"item add": func(t *testing.T, note *Note) error {
				_, err := store.CreateItemWithCompleted(t.Context(), note.ID, revisionOwnerID, "bread", 2, false, "", "")
				return err
			},
			"item add with ID": func(t *testing.T, note *Note) error {
				id, err := GenerateID()
				require.NoError(t, err)
				_, err = store.CreateItemWithID(t.Context(), note.ID, revisionOwnerID, id, "bread", 2, false, "", "", NoteItemsMaxCount)
				return err
			},
			"item edit": func(t *testing.T, note *Note) error {
				text := "oat milk"
				_, err := store.PatchItem(t.Context(), note.ID, revisionOwnerID, itemIDByText(t, store, note.ID, "milk"), NoteItemPatch{Text: &text})
				return err
			},
			"item toggle": func(t *testing.T, note *Note) error {
				_, err := store.ToggleItemCompleted(t.Context(), note.ID, revisionOwnerID, itemIDByText(t, store, note.ID, "milk"), true)
				return err
			},
			"items set completed": func(t *testing.T, note *Note) error {
				_, err := store.SetItemsCompleted(t.Context(), note.ID, revisionOwnerID, []string{itemIDByText(t, store, note.ID, "eggs")}, true)
				return err
			},
			"item delete": func(t *testing.T, note *Note) error {
				return store.DeleteItemFromNote(t.Context(), note.ID, revisionOwnerID, itemIDByText(t, store, note.ID, "milk"))
			},
			"items delete": func(t *testing.T, note *Note) error {
				_, err := store.DeleteItems(t.Context(), note.ID, revisionOwnerID, []string{itemIDByText(t, store, note.ID, "eggs")})
				return err
			},
			"item reorder": func(t *testing.T, note *Note) error {
				return store.ReorderItems(t.Context(), note.ID, revisionOwnerID, []string{
					itemIDByText(t, store, note.ID, "eggs"), itemIDByText(t, store, note.ID, "milk"),
				})
			},
			"title edit": func(t *testing.T, note *Note) error {
				title := "shopping"
				_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Title: &title})
				return err
			},
		}
		for name, write := range itemWrites {
			t.Run(name, func(t *testing.T) {
				note := createRevisionListNote(t, store)
				require.NoError(t, write(t, note))

				revisions := listRevisions(t, store, note.ID)
				require.Len(t, revisions, 1)
				rev := latestRevision(t, store, note.ID)
				assert.Equal(t, NoteTypeList, rev.NoteType)
				assert.Equal(t, "groceries", rev.Title)
				assert.Equal(t, []string{"milk", "eggs"}, revisionItemTexts(rev.Items))
				for _, item := range rev.Items {
					assert.False(t, item.Completed)
				}
			})
		}
	})
}

func TestNoteRevisionsCoalesce(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestRevisionStore(t, driver)

		edit := func(t *testing.T, ctx context.Context, noteID, userID, content string) {
			t.Helper()
			_, err := store.Update(ctx, noteID, userID, NoteUpdate{Content: &content})
			require.NoError(t, err)
		}

		t.Run("one writer's edits within the window make one revision", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "v0")
			edit(t, t.Context(), note.ID, revisionOwnerID, "v1")
			edit(t, t.Context(), note.ID, revisionOwnerID, "v2")
			edit(t, t.Context(), note.ID, revisionOwnerID, "v3")
			require.Len(t, listRevisions(t, store, note.ID), 1)
			assert.Equal(t, "v0", latestRevision(t, store, note.ID).Content)

			ageRevisions(t, store, note.ID)
			edit(t, t.Context(), note.ID, revisionOwnerID, "v4")
			require.Len(t, listRevisions(t, store, note.ID), 2)
			rev := latestRevision(t, store, note.ID)
			assert.Equal(t, "v3", rev.Content)
			require.NotNil(t, rev.ActorID)
			assert.Equal(t, revisionOwnerID, *rev.ActorID)
		})

		t.Run("another user's edit keeps the replaced content", func(t *testing.T) {
			note := createRevisionListNote(t, store)
			title := "owner title"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Title: &title})
			require.NoError(t, err)
			title = "collab title"
			_, err = store.Update(t.Context(), note.ID, revisionCollabID, NoteUpdate{Title: &title})
			require.NoError(t, err)

			require.Len(t, listRevisions(t, store, note.ID), 2)
			rev := latestRevision(t, store, note.ID)
			assert.Equal(t, "owner title", rev.Title)
			require.NotNil(t, rev.ActorID)
			assert.Equal(t, revisionOwnerID, *rev.ActorID, "the revision names who wrote its content")
		})

		t.Run("another client of the same user keeps the replaced content", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "v0")
			laptop := WithWriteClient(t.Context(), "laptop-tab")
			phone := WithWriteClient(t.Context(), "phone")
			edit(t, laptop, note.ID, revisionOwnerID, "from laptop")
			edit(t, phone, note.ID, revisionOwnerID, "from phone")
			edit(t, laptop, note.ID, revisionOwnerID, "laptop overwrite")

			revisions := listRevisions(t, store, note.ID)
			require.Len(t, revisions, 3)
			assert.Equal(t, "from phone", latestRevision(t, store, note.ID).Content)
		})

		t.Run("MCP rewrites do not coalesce with the webapp", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "v0")
			edit(t, WithWriteClient(t.Context(), "webapp-tab"), note.ID, revisionOwnerID, "typed in the webapp")
			edit(t, WithWriteClient(t.Context(), MCPWriteClient), note.ID, revisionOwnerID, "rewritten by an assistant")
			assert.Equal(t, "typed in the webapp", latestRevision(t, store, note.ID).Content)
		})

		t.Run("no-op writes record nothing", func(t *testing.T) {
			note := createRevisionListNote(t, store)
			title := note.Title
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Title: &title})
			require.NoError(t, err)
			milk := itemIDByText(t, store, note.ID, "milk")
			_, err = store.ToggleItemCompleted(t.Context(), note.ID, revisionOwnerID, milk, false)
			require.NoError(t, err)
			text := "milk"
			_, err = store.PatchItem(t.Context(), note.ID, revisionOwnerID, milk, NoteItemPatch{Text: &text})
			require.NoError(t, err)
			assert.Empty(t, listRevisions(t, store, note.ID))
		})

		t.Run("a rejected write records nothing", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "v0")
			stale := note.Version - 1
			content := "stale"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content, BaseVersion: &stale})
			require.ErrorIs(t, err, ErrNoteVersionConflict)
			assert.Empty(t, listRevisions(t, store, note.ID))
		})

		t.Run("an idempotent replay records nothing", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "v0")
			base := note.Version
			content := "v1"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content, BaseVersion: &base})
			require.NoError(t, err)
			ageRevisions(t, store, note.ID)
			_, err = store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content, BaseVersion: &base})
			require.NoError(t, err)
			assert.Len(t, listRevisions(t, store, note.ID), 1)
		})
	})
}

func TestNoteRevisionRestore(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestRevisionStore(t, driver)

		t.Run("restores content and can itself be undone", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "original")
			content := "edited"
			edited, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			original := latestRevision(t, store, note.ID)

			// Within the coalescing window, by the same writer: the restore
			// still snapshots what it replaces.
			restored, err := store.RestoreRevision(t.Context(), note.ID, original.ID, revisionOwnerID, &edited.Version)
			require.NoError(t, err)
			assert.Equal(t, "original", restored.Content)
			assert.Greater(t, restored.Version, edited.Version)

			undo := latestRevision(t, store, note.ID)
			assert.Equal(t, "edited", undo.Content)
			reverted, err := store.RestoreRevision(t.Context(), note.ID, undo.ID, revisionOwnerID, &restored.Version)
			require.NoError(t, err)
			assert.Equal(t, "edited", reverted.Content)
		})

		t.Run("restoring across a type change converts the note back", func(t *testing.T) {
			note := createRevisionListNote(t, store)
			before, err := store.getItemsByNoteID(t.Context(), note.ID)
			require.NoError(t, err)
			converted, err := store.ConvertType(t.Context(), note.ID, revisionOwnerID, NoteTypeText, "", "- [ ] milk\n- [ ] eggs", nil, nil)
			require.NoError(t, err)
			rev := latestRevision(t, store, note.ID)
			require.Equal(t, NoteTypeList, rev.NoteType)

			restored, err := store.RestoreRevision(t.Context(), note.ID, rev.ID, revisionOwnerID, &converted.Version)
			require.NoError(t, err)
			assert.Equal(t, NoteTypeList, restored.NoteType)
			assert.Equal(t, "groceries", restored.Title)
			require.Len(t, restored.Items, 2)
			for i, item := range restored.Items {
				assert.Equal(t, before[i].ID, item.ID, "restored items keep their IDs")
				assert.Equal(t, before[i].Text, item.Text)
			}
		})

		t.Run("an assignee is restored only while they can access the note", func(t *testing.T) {
			note := createRevisionListNote(t, store)
			milk := itemIDByText(t, store, note.ID, "milk")
			assignee := revisionCollabID
			_, err := store.PatchItem(t.Context(), note.ID, revisionOwnerID, milk, NoteItemPatch{AssignedTo: &assignee})
			require.NoError(t, err)
			ageRevisions(t, store, note.ID)
			text := "oat milk"
			_, err = store.PatchItem(t.Context(), note.ID, revisionOwnerID, milk, NoteItemPatch{Text: &text})
			require.NoError(t, err)
			rev := latestRevision(t, store, note.ID)
			require.Equal(t, revisionCollabID, rev.Items[0].AssignedTo)

			restored, err := store.RestoreRevision(t.Context(), note.ID, rev.ID, revisionOwnerID, nil)
			require.NoError(t, err)
			assert.Equal(t, revisionCollabID, restored.Items[0].AssignedTo)

			require.NoError(t, store.UnshareNote(t.Context(), note.ID, revisionCollabID))
			restored, err = store.RestoreRevision(t.Context(), note.ID, rev.ID, revisionOwnerID, nil)
			require.NoError(t, err)
			assert.Empty(t, restored.Items[0].AssignedTo)
		})

		t.Run("nobody, not even the owner, is assigned on a note no longer shared", func(t *testing.T) {
			note := createRevisionListNote(t, store)
			milk := itemIDByText(t, store, note.ID, "milk")
			assignee := revisionOwnerID
			_, err := store.PatchItem(t.Context(), note.ID, revisionOwnerID, milk, NoteItemPatch{AssignedTo: &assignee})
			require.NoError(t, err)
			ageRevisions(t, store, note.ID)
			text := "oat milk"
			_, err = store.PatchItem(t.Context(), note.ID, revisionOwnerID, milk, NoteItemPatch{Text: &text})
			require.NoError(t, err)
			rev := latestRevision(t, store, note.ID)
			require.Equal(t, revisionOwnerID, rev.Items[0].AssignedTo)

			require.NoError(t, store.UnshareNote(t.Context(), note.ID, revisionCollabID))
			restored, err := store.RestoreRevision(t.Context(), note.ID, rev.ID, revisionOwnerID, nil)
			require.NoError(t, err)
			assert.Equal(t, "milk", restored.Items[0].Text)
			assert.Empty(t, restored.Items[0].AssignedTo)
		})

		t.Run("restoring a revision that matches the note writes nothing", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "original")
			content := "edited"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			ageRevisions(t, store, note.ID)
			content = "original"
			current, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			revisions := listRevisions(t, store, note.ID)
			require.Len(t, revisions, 2)

			original := revisions[1]
			restored, err := store.RestoreRevision(t.Context(), note.ID, original.ID, revisionOwnerID, &current.Version)
			require.NoError(t, err)
			assert.Equal(t, current.Version, restored.Version)
			assert.Len(t, listRevisions(t, store, note.ID), 2)
		})

		t.Run("a stale base_version conflicts", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "original")
			content := "edited"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			rev := latestRevision(t, store, note.ID)
			_, err = store.RestoreRevision(t.Context(), note.ID, rev.ID, revisionOwnerID, &note.Version)
			require.ErrorIs(t, err, ErrNoteVersionConflict)
		})

		t.Run("a stale base_version conflicts even when only nesting differs", func(t *testing.T) {
			// The revision and the note agree on title, item text, and
			// completion; only eggs' nesting differs. A conversion replay check
			// would take that for an already-applied restore.
			note := createRevisionListNote(t, store)
			milk := itemIDByText(t, store, note.ID, "milk")
			eggs := itemIDByText(t, store, note.ID, "eggs")
			_, err := store.PatchItem(t.Context(), note.ID, revisionOwnerID, eggs, NoteItemPatch{ParentID: &milk})
			require.NoError(t, err)
			flat := latestRevision(t, store, note.ID)
			require.Nil(t, flat.Items[1].ParentID)
			for _, title := range []string{"renamed", "groceries"} {
				_, err = store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Title: &title})
				require.NoError(t, err)
			}

			_, err = store.RestoreRevision(t.Context(), note.ID, flat.ID, revisionOwnerID, &note.Version)
			require.ErrorIs(t, err, ErrNoteVersionConflict)
			current, err := store.GetByID(t.Context(), note.ID, revisionOwnerID)
			require.NoError(t, err)
			require.NotNil(t, current.Items[1].ParentID, "nothing was restored")
		})

		t.Run("a revision of another note is not found", func(t *testing.T) {
			a := createRevisionTextNote(t, store, "a")
			b := createRevisionTextNote(t, store, "b")
			content := "a2"
			_, err := store.Update(t.Context(), a.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			rev := latestRevision(t, store, a.ID)
			_, err = store.GetRevision(t.Context(), b.ID, rev.ID, revisionOwnerID)
			require.ErrorIs(t, err, ErrNoteRevisionNotFound)
			_, err = store.RestoreRevision(t.Context(), b.ID, rev.ID, revisionOwnerID, nil)
			require.ErrorIs(t, err, ErrNoteRevisionNotFound)
		})

		t.Run("history follows note access", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "private")
			_, err := store.ListRevisions(t.Context(), note.ID, revisionCollabID)
			require.ErrorIs(t, err, ErrNoteNotFound)

			require.NoError(t, store.ShareNote(t.Context(), note.ID, revisionOwnerID, revisionCollabID))
			revisions, err := store.ListRevisions(t.Context(), note.ID, revisionCollabID)
			require.NoError(t, err)
			assert.NotNil(t, revisions, "an empty history is [], not null")
		})
	})
}

func TestNoteRevisionRetention(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		store := newTestRevisionStore(t, driver)

		insertRevision := func(t *testing.T, noteID string, createdAt time.Time) {
			t.Helper()
			id, err := GenerateID()
			require.NoError(t, err)
			ts := Timestamp(createdAt)
			_, err = store.db.ExecContext(t.Context(),
				store.d.RewritePlaceholders(`INSERT INTO note_revisions (id, note_id, created_at, edited_at, note_type, replaced_by)
					VALUES (?, ?, ?, ?, ?, ?)`),
				id, noteID, ts, ts, NoteTypeText, revisionOwnerID)
			require.NoError(t, err)
		}

		t.Run("storing a revision trims the note to the count cap", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "busy")
			now := Now()
			for i := range NoteRevisionsMaxPerNote + 5 {
				insertRevision(t, note.ID, now.Add(-time.Duration(i+1)*time.Hour))
			}
			content := "busy v2"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)

			revisions := listRevisions(t, store, note.ID)
			require.Len(t, revisions, NoteRevisionsMaxPerNote)
			assert.Equal(t, "busy", latestRevision(t, store, note.ID).Content, "the new revision is kept")
			assert.WithinDuration(t, now.Add(-time.Duration(NoteRevisionsMaxPerNote-1)*time.Hour), revisions[len(revisions)-1].CreatedAt, time.Second,
				"the oldest revisions are dropped")
		})

		t.Run("pruning enforces the age cap", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "stale")
			now := Now()
			insertRevision(t, note.ID, now.Add(-NoteRevisionsMaxAge-time.Hour))
			insertRevision(t, note.ID, now.Add(-time.Hour))

			deleted, err := store.PruneRevisions(t.Context())
			require.NoError(t, err)
			assert.EqualValues(t, 1, deleted)
			assert.Len(t, listRevisions(t, store, note.ID), 1)
		})

		t.Run("a blank note's content is not kept", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "")
			content := "first words"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			assert.Empty(t, listRevisions(t, store, note.ID))
		})

		t.Run("purging a trashed note removes its revisions", func(t *testing.T) {
			note := createRevisionTextNote(t, store, "doomed")
			content := "doomed v2"
			_, err := store.Update(t.Context(), note.ID, revisionOwnerID, NoteUpdate{Content: &content})
			require.NoError(t, err)
			require.Len(t, listRevisions(t, store, note.ID), 1)

			require.NoError(t, store.MoveToTrash(t.Context(), note.ID, revisionOwnerID))
			_, err = store.db.ExecContext(t.Context(),
				store.d.RewritePlaceholders(`UPDATE notes SET deleted_at = ? WHERE id = ?`),
				Timestamp(Now().Add(-30*24*time.Hour)), note.ID)
			require.NoError(t, err)
			_, err = store.PurgeOldTrashedNotes(t.Context(), 7*24*time.Hour)
			require.NoError(t, err)

			var count int
			require.NoError(t, store.db.QueryRowContext(t.Context(),
				store.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_revisions WHERE note_id = ?`), note.ID,
			).Scan(&count))
			assert.Zero(t, count)
		})
	})
}
