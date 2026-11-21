package handlers

import (
	"context"
	"database/sql"
	"slices"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notify"
)

// deleteUserWithCleanup hard-deletes a user and everything that goes with
// them. It is the one implementation behind both DELETE /admin/users/{id} and
// DELETE /users/me, so the two cannot drift apart. Who may delete whom is the
// caller's check; this refuses only the last admin
// ([models.ErrLastAdmin]). Errors come back unwrapped, for the caller
// to pass to storeError, so a sentinel's message stays the API message.
// sourceUserID is who asked for the delete, reported on the SSE events that
// tell the user's collaborators about it.
func deleteUserWithCleanup(ctx context.Context, userStore *models.UserStore, noteStore *models.NoteStore, imageStore *blobstore.ImageStore, events *notify.Publisher, userID, sourceUserID string) error {
	// Deleting the user cascades away both their owned notes' note_images
	// rows and any note_images rows where they're the uploader on someone
	// else's note (note_images.uploader_id also cascades), so the candidate
	// blob hashes must be read before the delete — afterward the rows are
	// gone and there's nothing left to look up. The same holds for who must
	// hear of the delete: the user's notes and shares cascade away with them.
	// Reading via preDelete inside DeleteWithCleanup's own transaction
	// (rather than a separate query beforehand) keeps the reads atomic with
	// the delete: a plain query run before the call could miss an image or
	// share added in the gap between the read and the delete actually
	// starting.
	var shas []string
	var audiences *models.UserNoteAudiences
	err := userStore.DeleteWithCleanup(ctx, userID,
		func(ctx context.Context, tx *sql.Tx) error {
			var err error
			if shas, err = noteStore.GetNoteImageSHA256sForUserTx(ctx, tx, userID); err != nil {
				return err
			}
			audiences, err = noteStore.GetUserNoteAudiencesTx(ctx, tx, userID)
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

	// Published only now, after the commit, so a rolled-back delete sends
	// nothing. The deleted user is dropped from every audience: their
	// sessions went with them.
	for _, note := range audiences.Owned {
		events.NoteDeleted(ctx, note.NoteID, withoutUser(note.AudienceIDs, userID), sourceUserID)
	}
	// Losing the deleted user's share changes shared_with, and may clear
	// assignments, on notes that stay. note_unshared targeting the deleted
	// user makes every remaining member's client refetch the note, as when a
	// collaborator leaves a note.
	for _, note := range audiences.SharedWith {
		events.NoteUnshared(ctx, note.NoteID, withoutUser(note.AudienceIDs, userID), sourceUserID, userID)
	}
	return nil
}

func withoutUser(userIDs []string, userID string) []string {
	return slices.DeleteFunc(slices.Clone(userIDs), func(id string) bool { return id == userID })
}
