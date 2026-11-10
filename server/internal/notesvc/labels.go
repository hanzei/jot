package notesvc

import (
	"context"
	"errors"
	"strings"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/models"
)

// normalizeLabelName trims name and rejects an empty one.
func normalizeLabelName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", apierr.Invalid(errors.New("label name is required"))
	}
	return name, nil
}

// CreateLabel returns the user's label named name, creating it if it does not
// exist yet; created reports which happened. With a non-empty id it is a
// strict create instead: an existing label with that ID fails with
// models.ErrLabelIDConflict and one with that name with
// models.ErrLabelNameConflict, so an offline-created label can be replayed
// idempotently.
func (s *Service) CreateLabel(ctx context.Context, userID, id, name string) (label *models.Label, created bool, err error) {
	name, err = normalizeLabelName(name)
	if err != nil {
		return nil, false, err
	}

	if id != "" {
		if !models.IsValidID(id) {
			return nil, false, apierr.Invalid(errors.New("invalid label ID format"))
		}
		label, err = s.labelStore.CreateLabel(ctx, userID, id, name)
		created = true
	} else {
		// An overlong name still matches an existing label; only a new one is
		// rejected (models.ErrLabelNameTooLong).
		label, created, err = s.labelStore.GetOrCreateLabel(ctx, userID, name)
	}
	if err != nil {
		return nil, false, err
	}

	s.events.LabelsChanged(ctx, userID, label)
	return label, created, nil
}

// RenameLabel renames one of the user's labels and announces the change on
// every note carrying it.
func (s *Service) RenameLabel(ctx context.Context, labelID, userID, name string) (*models.Label, error) {
	name, err := normalizeLabelName(name)
	if err != nil {
		return nil, err
	}
	if err = models.ValidateLabelName(name); err != nil {
		return nil, err
	}

	// Collect the notes first: the rename changes how each of them renders.
	noteIDs, err := s.labelStore.GetLabelNoteIDs(ctx, labelID, userID)
	if err != nil {
		return nil, err
	}
	label, err := s.labelStore.RenameLabel(ctx, labelID, userID, name)
	if err != nil {
		return nil, err
	}

	s.events.LabelNoteUpdates(ctx, noteIDs, userID)
	return label, nil
}

// DeleteLabel deletes one of the user's labels, detaching it from every note,
// and announces the change on those notes.
func (s *Service) DeleteLabel(ctx context.Context, labelID, userID string) error {
	// Collect the notes first: the delete removes the rows that link them.
	noteIDs, err := s.labelStore.GetLabelNoteIDs(ctx, labelID, userID)
	if err != nil {
		return err
	}
	if err = s.labelStore.DeleteLabel(ctx, labelID, userID); err != nil {
		return err
	}

	s.events.LabelNoteUpdates(ctx, noteIDs, userID)
	return nil
}

// AddLabelToNote attaches the user's label named name to the note, creating
// the label if it does not exist yet, and returns the updated note.
func (s *Service) AddLabelToNote(ctx context.Context, noteID, userID, name string) (*models.Note, error) {
	name, err := normalizeLabelName(name)
	if err != nil {
		return nil, err
	}
	// Check access before attachLabels creates the label, so a note the user
	// cannot reach does not leave a new, unattached label behind.
	hasAccess, err := s.noteStore.HasAccess(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	if !hasAccess {
		return nil, models.ErrNoteNoAccess
	}
	if err = s.attachLabels(ctx, noteID, userID, []string{name}); err != nil {
		return nil, err
	}
	return s.labelsChanged(ctx, noteID, userID)
}

// RemoveLabelFromNote detaches a label from the note and returns the updated
// note.
func (s *Service) RemoveLabelFromNote(ctx context.Context, noteID, labelID, userID string) (*models.Note, error) {
	if err := s.noteStore.RemoveLabelFromNote(ctx, noteID, labelID, userID); err != nil {
		return nil, err
	}
	return s.labelsChanged(ctx, noteID, userID)
}

// labelsChanged reads back a note whose labels the user changed and announces
// it.
func (s *Service) labelsChanged(ctx context.Context, noteID, userID string) (*models.Note, error) {
	note, err := s.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, refetchError("get note", err)
	}
	// Labels are per-user, so only the user's own view of the note changed.
	s.events.NoteUpdated(ctx, noteID, note, userID, false)
	return note, nil
}
