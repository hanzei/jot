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

// TestLabels covers the label operations end to end and pins the errors the
// REST handlers map to statuses: invalid input is 400, an overlong new name
// 422, and the label sentinels pass through for the handlers' own mapping.
func TestLabels(t *testing.T) {
	t.Parallel()
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		svc, _ := newTestService(t, driver)
		ctx := t.Context()

		note, err := svc.Create(ctx, testUserID, NewNote{Content: "a"})
		require.NoError(t, err)

		t.Run("add creates the label once and trims the name", func(t *testing.T) {
			updated, err := svc.AddLabelToNote(ctx, note.ID, testUserID, "  work ")
			require.NoError(t, err)
			require.Len(t, updated.Labels, 1)
			assert.Equal(t, "work", updated.Labels[0].Name)

			label, created, err := svc.CreateLabel(ctx, testUserID, "", "work")
			require.NoError(t, err)
			assert.False(t, created, "get-or-create returns the existing label")
			assert.Equal(t, updated.Labels[0].ID, label.ID)
		})

		t.Run("rename and remove", func(t *testing.T) {
			label, _, err := svc.CreateLabel(ctx, testUserID, "", "work")
			require.NoError(t, err)

			renamed, err := svc.RenameLabel(ctx, label.ID, testUserID, " office ")
			require.NoError(t, err)
			assert.Equal(t, "office", renamed.Name)

			updated, err := svc.RemoveLabelFromNote(ctx, note.ID, label.ID, testUserID)
			require.NoError(t, err)
			assert.Empty(t, updated.Labels)
		})

		t.Run("invalid input", func(t *testing.T) {
			existing, _, err := svc.CreateLabel(ctx, testUserID, "", "taken")
			require.NoError(t, err)
			tooLong := strings.Repeat("a", models.LabelNameMaxLength+1)

			for _, tc := range []struct {
				name   string
				call   func() error
				status int
				code   apierr.Code
			}{
				{"create with an empty name", func() error {
					_, _, err := svc.CreateLabel(ctx, testUserID, "", "  ")
					return err
				}, http.StatusBadRequest, apierr.CodeValidationFailed},
				{"create with a bad ID", func() error {
					_, _, err := svc.CreateLabel(ctx, testUserID, "nope", "x")
					return err
				}, http.StatusBadRequest, apierr.CodeValidationFailed},
				{"create with an overlong name", func() error {
					_, _, err := svc.CreateLabel(ctx, testUserID, "", tooLong)
					return err
				}, http.StatusUnprocessableEntity, apierr.CodeLabelNameTooLong},
				{"rename to an overlong name", func() error {
					_, err := svc.RenameLabel(ctx, existing.ID, testUserID, tooLong)
					return err
				}, http.StatusUnprocessableEntity, apierr.CodeLabelNameTooLong},
				{"add with an empty name", func() error {
					_, err := svc.AddLabelToNote(ctx, note.ID, testUserID, "")
					return err
				}, http.StatusBadRequest, apierr.CodeValidationFailed},
			} {
				t.Run(tc.name, func(t *testing.T) {
					requireAPIError(t, tc.call(), tc.status, tc.code)
				})
			}
		})

		t.Run("store sentinels pass through", func(t *testing.T) {
			taken, _, err := svc.CreateLabel(ctx, testUserID, "", "kept")
			require.NoError(t, err)
			other, _, err := svc.CreateLabel(ctx, testUserID, "", "other")
			require.NoError(t, err)
			newID, err := models.GenerateID()
			require.NoError(t, err)

			_, _, err = svc.CreateLabel(ctx, testUserID, taken.ID, "fresh")
			require.ErrorIs(t, err, models.ErrLabelIDConflict)
			_, _, err = svc.CreateLabel(ctx, testUserID, newID, "kept")
			require.ErrorIs(t, err, models.ErrLabelNameConflict)
			_, err = svc.RenameLabel(ctx, other.ID, testUserID, "kept")
			require.ErrorIs(t, err, models.ErrLabelNameConflict)
			_, err = svc.AddLabelToNote(ctx, missingID, testUserID, "orphan")
			require.ErrorIs(t, err, models.ErrNoteNoAccess)
			_, err = svc.labelStore.GetLabelByName(ctx, testUserID, "orphan")
			require.ErrorIs(t, err, models.ErrLabelNotFoundOrNotOwned, "no label is created for an unreachable note")
			_, err = svc.RenameLabel(ctx, missingID, testUserID, "x")
			require.ErrorIs(t, err, models.ErrLabelNotFoundOrNotOwned)
			require.ErrorIs(t, svc.DeleteLabel(ctx, missingID, testUserID), models.ErrLabelNotFoundOrNotOwned)
		})

		t.Run("delete detaches the label", func(t *testing.T) {
			updated, err := svc.AddLabelToNote(ctx, note.ID, testUserID, "doomed")
			require.NoError(t, err)
			require.Len(t, updated.Labels, 1)

			require.NoError(t, svc.DeleteLabel(ctx, updated.Labels[0].ID, testUserID))
			after, err := svc.noteStore.GetByID(ctx, note.ID, testUserID)
			require.NoError(t, err)
			assert.Empty(t, after.Labels)
		})
	})
}
