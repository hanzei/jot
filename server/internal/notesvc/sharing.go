package notesvc

import (
	"context"
	"errors"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

// UserSearchLimit caps ListUsers with a search term: the pickers that search
// are typeahead lists, so more rows than this only means the term needs
// refining. Listing without a term is not capped, since clients use it to
// resolve user IDs to names and avatars.
const UserSearchLimit = 50

// ListUsers returns every user other than userID or, with a search term, at
// most UserSearchLimit of those matching it, newest first. truncated reports
// that a search matched more than that.
func (s *Service) ListUsers(ctx context.Context, userID, search string) (users []*models.User, truncated bool, err error) {
	if vErr := models.ValidateSearchQuery(search); vErr != nil {
		return nil, false, apierr.Invalid(vErr)
	}

	if search != "" {
		// One extra row tells a result of exactly the limit apart from a
		// truncated one.
		users, err = s.userStore.Search(ctx, search, userID, UserSearchLimit+1)
		if err != nil {
			return nil, false, err
		}
		if len(users) > UserSearchLimit {
			return users[:UserSearchLimit], true, nil
		}
		return users, false, nil
	}

	all, err := s.userStore.GetAll(ctx)
	if err != nil {
		return nil, false, err
	}
	users = make([]*models.User, 0, len(all))
	for _, u := range all {
		if u.ID != userID {
			users = append(users, u)
		}
	}
	return users, false, nil
}

// Share shares a note userID owns with targetUserID and announces it to the
// note's audience, the new collaborator included.
func (s *Service) Share(ctx context.Context, noteID, userID, targetUserID string) error {
	if !models.IsValidID(targetUserID) {
		return apierr.Invalid(errors.New("invalid user_id"))
	}
	if err := s.requireOwner(ctx, noteID, userID); err != nil {
		return err
	}
	if targetUserID == userID {
		return models.ErrCannotShareWithSelf
	}
	if _, err := s.userStore.GetByID(ctx, targetUserID); err != nil {
		return err
	}

	if err := s.noteStore.ShareNote(ctx, noteID, userID, targetUserID); err != nil {
		return err
	}

	// Personalized, so each recipient sees only their own labels.
	if audienceIDs, err := s.noteStore.GetNoteAudienceIDs(ctx, noteID); err == nil {
		s.events.NoteShared(ctx, noteID, audienceIDs, userID, targetUserID)
	} else {
		logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).Error("Failed to get note audience for SSE publish")
	}
	return nil
}

// Unshare removes targetUserID's access to a note. The owner may remove any
// collaborator; anyone else may remove only themselves, i.e. leave a note
// shared with them. Leaving reduces only your own access, so it never needs
// ownership.
func (s *Service) Unshare(ctx context.Context, noteID, userID, targetUserID string) error {
	if targetUserID != userID {
		if err := s.requireOwner(ctx, noteID, userID); err != nil {
			return err
		}
	}

	// Resolve the audience before unsharing, while the target is still in it.
	audienceIDs, audienceErr := s.noteStore.GetNoteAudienceIDs(ctx, noteID)

	if err := s.noteStore.UnshareNote(ctx, noteID, targetUserID); err != nil {
		return err
	}

	if audienceErr == nil {
		s.events.NoteUnshared(ctx, noteID, audienceIDs, userID, targetUserID)
	} else {
		logutil.FromContext(ctx).WithError(audienceErr).WithField("note_id", noteID).Error("Failed to get note audience for SSE publish")
	}
	return nil
}

// requireOwner returns models.ErrNotNoteOwner unless userID owns the note.
func (s *Service) requireOwner(ctx context.Context, noteID, userID string) error {
	isOwner, err := s.noteStore.IsOwner(ctx, noteID, userID)
	if err != nil {
		return err
	}
	if !isOwner {
		return models.ErrNotNoteOwner
	}
	return nil
}
