package handlers

import (
	"context"
	"database/sql"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/models"
)

// deleteUserWithCleanup hard-deletes a user and everything that goes with
// them. It is the one implementation behind both DELETE /admin/users/{id} and
// DELETE /users/me, so the two cannot drift apart. Who may delete whom is the
// caller's check; this refuses only the last admin
// ([models.ErrLastAdminDelete]). Errors come back unwrapped, for the caller
// to pass to storeError, so a sentinel's message stays the API message.
func deleteUserWithCleanup(ctx context.Context, userStore *models.UserStore, noteStore *models.NoteStore, imageStore *blobstore.ImageStore, userID string) error {
	// Deleting the user cascades away both their owned notes' note_images
	// rows and any note_images rows where they're the uploader on someone
	// else's note (note_images.uploader_id also cascades), so the candidate
	// blob hashes must be read before the delete — afterward the rows are
	// gone and there's nothing left to look up. Reading via preDelete inside
	// DeleteWithCleanup's own transaction (rather than a separate query
	// beforehand) keeps the read atomic with the delete: a plain query run
	// before the call could miss an image added in the gap between the read
	// and the delete actually starting.
	var shas []string
	err := userStore.DeleteWithCleanup(ctx, userID,
		func(ctx context.Context, tx *sql.Tx) error {
			var err error
			shas, err = noteStore.GetNoteImageSHA256sForUserTx(ctx, tx, userID)
			return err
		},
		func(ctx context.Context, tx *sql.Tx) error {
			return noteStore.ClearUserAssignmentsTx(ctx, tx, userID)
		},
	)
	if err != nil {
		return err
	}

	blobstore.ReclaimOrphaned(ctx, noteStore, imageStore, shas)
	return nil
}
