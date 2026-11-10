package notesvc

import (
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestItemErrors pins the error contract of the item operations, which the
// REST handlers turn into statuses and the MCP tools into tool errors.
func TestItemErrors(t *testing.T) {
	t.Parallel()
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		svc, _ := newTestService(t, driver)
		ctx := t.Context()

		list, err := svc.Create(ctx, testUserID, NewNote{Items: []NewItem{{Text: "a"}}})
		require.NoError(t, err)
		text, err := svc.Create(ctx, testUserID, NewNote{Content: "b"})
		require.NoError(t, err)

		longText := strings.Repeat("a", models.NoteItemTextMaxLength+1)
		badID := "not-an-id"
		missingID := "0000000000000000missing"
		tooManyIDs := make([]string, models.NoteItemsMaxCount+1)
		assignee, err := models.GenerateID()
		require.NoError(t, err)

		for _, tc := range []struct {
			name   string
			call   func() error
			status int
			msg    string
		}{
			{"text note", func() error {
				_, err := svc.CreateItem(ctx, text.ID, testUserID, NewListItem{Text: "x"})
				return err
			}, http.StatusBadRequest, "items can only be modified on list notes"},
			{"missing note", func() error {
				_, err := svc.CreateItem(ctx, missingID, testUserID, NewListItem{Text: "x"})
				return err
			}, http.StatusNotFound, models.ErrNoteNotFound.Error()},
			{"bad item ID", func() error {
				_, err := svc.CreateItem(ctx, list.ID, testUserID, NewListItem{ID: badID})
				return err
			}, http.StatusBadRequest, "invalid item ID format"},
			{"create text too long", func() error {
				_, err := svc.CreateItem(ctx, list.ID, testUserID, NewListItem{Text: longText})
				return err
			}, http.StatusBadRequest, "item text must be 500 characters or fewer"},
			{"create bad parent_id", func() error {
				_, err := svc.CreateItem(ctx, list.ID, testUserID, NewListItem{ParentID: badID})
				return err
			}, http.StatusBadRequest, "invalid parent_id format"},
			{"assignee on an unshared note", func() error {
				_, err := svc.CreateItem(ctx, list.ID, testUserID, NewListItem{AssignedTo: assignee})
				return err
			}, http.StatusBadRequest, "cannot assign items on an unshared note"},
			{"patch text too long", func() error {
				_, err := svc.PatchItem(ctx, list.ID, testUserID, list.Items[0].ID, models.NoteItemPatch{Text: &longText})
				return err
			}, http.StatusBadRequest, "item text must be 500 characters or fewer"},
			{"patch bad parent_id", func() error {
				_, err := svc.PatchItem(ctx, list.ID, testUserID, list.Items[0].ID, models.NoteItemPatch{ParentID: &badID})
				return err
			}, http.StatusBadRequest, "invalid parent_id format"},
			{"delete missing item", func() error {
				return svc.DeleteItem(ctx, list.ID, testUserID, missingID)
			}, http.StatusNotFound, models.ErrNoteItemNotFound.Error()},
			{"reorder without IDs", func() error {
				return svc.ReorderItems(ctx, list.ID, testUserID, nil)
			}, http.StatusBadRequest, "empty item IDs list"},
			{"bulk over the cap", func() error {
				_, err := svc.SetItemsCompleted(ctx, list.ID, testUserID, tooManyIDs, true)
				return err
			}, http.StatusBadRequest, "cannot operate on more than 500 items at once"},
			{"bulk bad ID", func() error {
				_, err := svc.DeleteItems(ctx, list.ID, testUserID, []string{badID})
				return err
			}, http.StatusBadRequest, "invalid item ID format"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				err := tc.call()
				require.Error(t, err)
				status, ok := apierr.SentinelStatus(err)
				require.True(t, ok, "no status for %v", err)
				assert.Equal(t, tc.status, status)
				assert.EqualError(t, err, tc.msg)
			})
		}
	})
}

// TestCreateItemPosition checks that an omitted position appends the item to
// the end of the list and a given one is kept.
func TestCreateItemPosition(t *testing.T) {
	t.Parallel()
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		svc, _ := newTestService(t, driver)
		ctx := t.Context()

		note, err := svc.Create(ctx, testUserID, NewNote{Items: []NewItem{{Text: "a", Position: 0}, {Text: "b", Position: 4}}})
		require.NoError(t, err)

		item, err := svc.CreateItem(ctx, note.ID, testUserID, NewListItem{Text: "c"})
		require.NoError(t, err)
		assert.Equal(t, 5, item.Position)

		between := 2
		item, err = svc.CreateItem(ctx, note.ID, testUserID, NewListItem{Text: "d", Position: &between})
		require.NoError(t, err)
		assert.Equal(t, between, item.Position)
	})
}
