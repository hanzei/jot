package notesvc

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/models"
)

// NewListItem is the input to CreateItem.
type NewListItem struct {
	// ID is optional; one is generated when empty. A client supplies it so
	// the item has a stable identity for later updates and offline replay.
	ID   string
	Text string
	// Position is where the item goes in the note's order; nil appends it to
	// the end of the list. The store re-sequences the note afterwards so a
	// child sorts directly after its parent, so the stored value may differ.
	Position  *int
	Completed bool
	// ParentID nests the item under a top-level item of the same note.
	ParentID   string
	AssignedTo string
}

// CreateItem adds an item to a list note and announces the change.
func (s *Service) CreateItem(ctx context.Context, noteID, userID string, in NewListItem) (*models.NoteItem, error) {
	note, err := s.loadListNote(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	if in.ID != "" && !models.IsValidID(in.ID) {
		return nil, apierr.Invalid(errors.New("invalid item ID format"))
	}
	if err = validateItemText(in.Text); err != nil {
		return nil, err
	}
	if err = validateParentID(in.ParentID); err != nil {
		return nil, err
	}
	if err = note.ValidateAssignee(in.AssignedTo); err != nil {
		return nil, apierr.Invalid(err)
	}

	// CreateItemWithID does not generate an ID for an empty string.
	itemID := in.ID
	if itemID == "" {
		if itemID, err = models.GenerateID(); err != nil {
			return nil, fmt.Errorf("generate item ID: %w", err)
		}
	}
	position := nextItemPosition(note)
	if in.Position != nil {
		position = *in.Position
	}

	// The item cap is enforced atomically inside the create transaction, so a
	// pre-check here would only race.
	item, err := s.noteStore.CreateItemWithID(ctx, noteID, userID, itemID, in.Text, position, in.Completed, in.ParentID, in.AssignedTo, models.NoteItemsMaxCount)
	if err != nil {
		return nil, err
	}
	s.announceItemChange(ctx, noteID, userID)
	return item, nil
}

// nextItemPosition returns the position that appends an item to the end of
// the note's current list.
func nextItemPosition(note *models.Note) int {
	next := 0
	for _, item := range note.Items {
		if item.Position >= next {
			next = item.Position + 1
		}
	}
	return next
}

// PatchItem changes the set fields of one item of a list note and announces
// the change. Setting only the changed fields lets concurrent edits to
// different fields of the same item merge.
func (s *Service) PatchItem(ctx context.Context, noteID, userID, itemID string, patch models.NoteItemPatch) (*models.NoteItem, error) {
	note, err := s.loadListNote(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	if patch.Text != nil {
		if err = validateItemText(*patch.Text); err != nil {
			return nil, err
		}
	}
	if patch.ParentID != nil {
		if err = validateParentID(*patch.ParentID); err != nil {
			return nil, err
		}
	}
	if patch.AssignedTo != nil {
		if err = note.ValidateAssignee(*patch.AssignedTo); err != nil {
			return nil, apierr.Invalid(err)
		}
	}

	item, err := s.noteStore.PatchItem(ctx, noteID, userID, itemID, patch)
	if err != nil {
		return nil, err
	}
	s.announceItemChange(ctx, noteID, userID)
	return item, nil
}

// DeleteItem deletes one item of a list note and announces the change. It
// returns models.ErrNoteItemNotFound if the note has no such item.
func (s *Service) DeleteItem(ctx context.Context, noteID, userID, itemID string) error {
	if _, err := s.loadListNote(ctx, noteID, userID); err != nil {
		return err
	}
	_, deleted, err := s.noteStore.DeleteItems(ctx, noteID, userID, []string{itemID})
	if err != nil {
		return err
	}
	if deleted == 0 {
		return models.ErrNoteItemNotFound
	}
	s.announceItemChange(ctx, noteID, userID)
	return nil
}

// ReorderItems sets each item's position to its index in itemIDs and
// announces the change.
func (s *Service) ReorderItems(ctx context.Context, noteID, userID string, itemIDs []string) error {
	if _, err := s.loadListNote(ctx, noteID, userID); err != nil {
		return err
	}
	if len(itemIDs) == 0 {
		return apierr.Invalid(errors.New("empty item IDs list"))
	}
	for _, id := range itemIDs {
		if !models.IsValidID(id) {
			return apierr.Invalid(errors.New("invalid item ID format"))
		}
	}

	if err := s.noteStore.ReorderItems(ctx, noteID, userID, itemIDs); err != nil {
		return err
	}
	s.announceItemChange(ctx, noteID, userID)
	return nil
}

// SetItemsCompleted checks or unchecks the given items of a list note,
// cascading between parents and children, announces the change, and returns
// the note's items. IDs that are not on the note are ignored.
func (s *Service) SetItemsCompleted(ctx context.Context, noteID, userID string, itemIDs []string, completed bool) ([]models.NoteItem, error) {
	if _, err := s.loadListNote(ctx, noteID, userID); err != nil {
		return nil, err
	}
	if err := validateBulkItemIDs(itemIDs); err != nil {
		return nil, err
	}

	items, err := s.noteStore.SetItemsCompleted(ctx, noteID, userID, itemIDs, completed)
	if err != nil {
		return nil, err
	}
	s.announceItemChange(ctx, noteID, userID)
	return items, nil
}

// DeleteItems deletes the given items of a list note and returns the note's
// remaining items. IDs that are already gone (an offline client's replay) are
// ignored; the change is announced only if something was deleted.
func (s *Service) DeleteItems(ctx context.Context, noteID, userID string, itemIDs []string) ([]models.NoteItem, error) {
	if _, err := s.loadListNote(ctx, noteID, userID); err != nil {
		return nil, err
	}
	if err := validateBulkItemIDs(itemIDs); err != nil {
		return nil, err
	}

	items, deleted, err := s.noteStore.DeleteItems(ctx, noteID, userID, itemIDs)
	if err != nil {
		return nil, err
	}
	// A call that removed nothing changed nothing and wakes no collaborator.
	if deleted > 0 {
		s.announceItemChange(ctx, noteID, userID)
	}
	return items, nil
}

// loadListNote resolves the note for an item operation. GetByID only returns
// notes the user owns or that are shared with them, so it doubles as the
// access check; the note must also be a list.
func (s *Service) loadListNote(ctx context.Context, noteID, userID string) (*models.Note, error) {
	note, err := s.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	if note.NoteType != models.NoteTypeList {
		return nil, apierr.Invalid(errors.New("items can only be modified on list notes"))
	}
	return note, nil
}

// announceItemChange tells every collaborator that a note's items changed.
// Items are shared content, so each audience member receives their own copy
// of the note, with their per-user state and unread badge.
func (s *Service) announceItemChange(ctx context.Context, noteID, userID string) {
	s.events.NoteUpdated(ctx, noteID, nil, userID, true)
}

// validateItemText enforces the per-item text length limit.
func validateItemText(text string) error {
	if utf8.RuneCountInString(text) > models.NoteItemTextMaxLength {
		return apierr.Invalid(fmt.Errorf("item text must be %d characters or fewer", models.NoteItemTextMaxLength))
	}
	return nil
}

// validateParentID checks a parent_id's format; "" means top-level. Whether
// the parent exists on the note is the store's check.
func validateParentID(parentID string) error {
	if parentID != "" && !models.IsValidID(parentID) {
		return apierr.Invalid(errors.New("invalid parent_id format"))
	}
	return nil
}

// validateBulkItemIDs checks that a bulk item-ID list is present,
// well-formed, and not larger than a note can hold. The cap bounds how many
// per-item queries one bulk call can run, a guard against accidental
// overload; NoteItemsMaxCount is the natural ceiling since no note holds
// more.
func validateBulkItemIDs(itemIDs []string) error {
	if len(itemIDs) == 0 {
		return apierr.Invalid(errors.New("empty item IDs list"))
	}
	if len(itemIDs) > models.NoteItemsMaxCount {
		return apierr.Invalid(fmt.Errorf("cannot operate on more than %d items at once", models.NoteItemsMaxCount))
	}
	for _, id := range itemIDs {
		if !models.IsValidID(id) {
			return apierr.Invalid(errors.New("invalid item ID format"))
		}
	}
	return nil
}
