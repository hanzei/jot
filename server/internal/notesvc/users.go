package notesvc

import (
	"context"
	"database/sql"
	"fmt"
	"slices"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/models"
)

// DeleteUser hard-deletes a user and everything that goes with them, and tells
// their collaborators. It is the one implementation behind both DELETE
// /admin/users/{id} and DELETE /users/me, so the two cannot drift apart. Who
// may delete whom is the caller's check; this refuses only the last admin
// ([models.ErrLastAdmin]). sourceUserID is who asked for the delete.
func (s *Service) DeleteUser(ctx context.Context, userID, sourceUserID string) error {
	// Deleting the user cascades away their owned notes, their shares, and
	// every image they uploaded (note_images.uploader_id cascades too, also
	// on other users' notes). So the candidate blob hashes and the audiences
	// to notify must be read before the delete, inside its transaction
	// (preDelete). On SQLite that makes the reads atomic with the delete; on
	// Postgres (READ COMMITTED) each statement sees the latest commits, so an
	// image or share added in the moment between a read and the delete is
	// still missed: its blob waits for the next orphan sweep, and no event
	// is sent for it.
	var shas []string
	var audiences *models.UserNoteAudiences
	err := s.userStore.DeleteWithCleanup(ctx, userID,
		func(ctx context.Context, tx *sql.Tx) error {
			var err error
			if shas, err = s.noteStore.GetNoteImageSHA256sForUserTx(ctx, tx, userID); err != nil {
				return fmt.Errorf("get image hashes: %w", err)
			}
			if audiences, err = s.noteStore.GetUserNoteAudiencesTx(ctx, tx, userID); err != nil {
				return fmt.Errorf("get note audiences: %w", err)
			}
			return nil
		},
		func(ctx context.Context, tx *sql.Tx) error {
			return s.noteStore.ClearUserAssignmentsTx(ctx, tx, userID)
		},
	)
	if err != nil {
		return err
	}

	blobstore.ReclaimOrphaned(ctx, s.noteStore, s.imageStore, shas)

	// Published only now, after the commit, so a rolled-back delete sends
	// nothing. The deleted user's sessions went with them.
	for _, note := range audiences.Owned {
		audienceIDs := slices.DeleteFunc(note.AudienceIDs, func(id string) bool { return id == userID })
		s.events.NoteDeleted(ctx, note.NoteID, audienceIDs, sourceUserID)
	}
	if len(audiences.Owned) > 0 {
		s.notesDeleted.Add(ctx, int64(len(audiences.Owned)))
	}
	// Losing the user's share, assignments or uploads changes notes that
	// stay. note_unshared targeting the user makes each remaining member's
	// client refetch the note, as when a collaborator leaves it.
	for _, note := range audiences.SharedWith {
		s.events.NoteUnshared(ctx, note.NoteID, note.AudienceIDs, sourceUserID, userID)
	}
	return nil
}

// DeleteAllNotesOf permanently deletes every note ownerID owns, in any state,
// and returns how many there were. The owner keeps their account, so their
// own sessions hear note_deleted along with the collaborators.
func (s *Service) DeleteAllNotesOf(ctx context.Context, ownerID, sourceUserID string) (int, error) {
	deleted, shas, err := s.noteStore.DeleteAllByUser(ctx, ownerID)
	if err != nil {
		return 0, err
	}
	blobstore.ReclaimOrphaned(ctx, s.noteStore, s.imageStore, shas)

	for _, note := range deleted {
		s.events.NoteDeleted(ctx, note.NoteID, note.AudienceIDs, sourceUserID)
	}
	if len(deleted) > 0 {
		s.notesDeleted.Add(ctx, int64(len(deleted)))
	}
	return len(deleted), nil
}
