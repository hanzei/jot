package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

// CreateNoteItemRequest is the body for POST /notes/{id}/items. The client
// supplies the item ID so the new item has a stable identity for subsequent
// per-item updates and offline replay; if omitted, the server generates one.
type CreateNoteItemRequest struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	Position  int    `json:"position"`
	Completed bool   `json:"completed"`
	// ParentID nests the item under a top-level item in the same note. Empty or
	// omitted means the item is top-level. Replaces the former indent_level.
	ParentID   string `json:"parent_id"`
	AssignedTo string `json:"assigned_to"`
}

// PatchNoteItemRequest is the body for PATCH /notes/{id}/items/{item_id}. Only
// non-nil fields are changed, so concurrent edits to different columns of the
// same item merge instead of clobbering one another.
type PatchNoteItemRequest struct {
	Text      *string `json:"text"`
	Completed *bool   `json:"completed"`
	Position  *int    `json:"position"`
	// ParentID, when present, re-parents the item ("" makes it top-level).
	ParentID   *string `json:"parent_id"`
	AssignedTo *string `json:"assigned_to"`
}

// ToggleNoteItemCompletedRequest is the body for
// POST /notes/{id}/items/{item_id}/toggle-completed.
type ToggleNoteItemCompletedRequest struct {
	// Completed is a pointer so an omitted field is rejected by the handler
	// rather than silently decoding to false and unchecking the item.
	Completed *bool `json:"completed"`
}

// ReorderNoteItemsRequest is the body for POST /notes/{id}/items/reorder.
type ReorderNoteItemsRequest struct {
	ItemIDs []string `json:"item_ids"`
}

// loadListNoteForItemOp resolves the note for an item operation, enforcing
// access (GetByID only returns notes the user owns or has shared with them) and
// that the note is a list. It returns the appropriate HTTP status on failure.
func (h *NotesHandler) loadListNoteForItemOp(ctx context.Context, noteID, userID string) (*models.Note, int, error) {
	note, err := h.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) {
			return nil, http.StatusNotFound, err
		}
		return nil, http.StatusInternalServerError, fmt.Errorf("get note: %w", err)
	}
	if note.NoteType != models.NoteTypeList {
		return nil, http.StatusBadRequest, errors.New("items can only be modified on list notes")
	}
	return note, http.StatusOK, nil
}

// validateItemAssignee checks that assignedTo (when non-empty) is a valid user
// with access to the note. Mirrors the rules in validateItemAssignments for the
// single-item case.
func (h *NotesHandler) validateItemAssignee(ctx context.Context, noteID, assignedTo string) (int, error) {
	if assignedTo == "" {
		return http.StatusOK, nil
	}
	if !models.IsValidID(assignedTo) {
		return http.StatusBadRequest, errors.New("invalid assigned_to format")
	}

	shares, err := h.noteStore.GetNoteShares(ctx, noteID)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("failed to check note shares: %w", err)
	}
	if len(shares) == 0 {
		return http.StatusBadRequest, errors.New("cannot assign items on an unshared note")
	}

	ownerID, err := h.noteStore.GetOwnerID(ctx, noteID)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("failed to get note owner: %w", err)
	}

	if assignedTo == ownerID {
		return http.StatusOK, nil
	}
	for _, share := range shares {
		if share.SharedWithUserID == assignedTo {
			return http.StatusOK, nil
		}
	}
	return http.StatusBadRequest, errors.New("assigned user does not have access to this note")
}

// validateItemText enforces the per-item text length constraint.
func validateItemText(text string) (int, error) {
	if utf8.RuneCountInString(text) > noteItemTextMaxLength {
		return http.StatusBadRequest, fmt.Errorf("item text must be %d characters or fewer", noteItemTextMaxLength)
	}
	return http.StatusOK, nil
}

// CreateNoteItem godoc
//
//	@Summary	Add a single item to a list note
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string					true	"Note ID"
//	@Param		body	body		CreateNoteItemRequest	true	"Item to add"
//	@Success	201		{object}	models.NoteItem
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	409		{string}	string	"item already exists"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/items [post]
func (h *NotesHandler) CreateNoteItem(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	if !models.IsValidID(noteID) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	if _, status, err := h.loadListNoteForItemOp(r.Context(), noteID, user.ID); err != nil {
		return status, nil, err
	}

	var req CreateNoteItemRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	itemID := req.ID
	if itemID == "" {
		generated, err := models.GenerateID()
		if err != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("generate item ID: %w", err)
		}
		itemID = generated
	} else if !models.IsValidID(itemID) {
		return http.StatusBadRequest, nil, errors.New("invalid item ID format")
	}

	if status, err := validateItemText(req.Text); err != nil {
		return status, nil, err
	}
	if req.ParentID != "" && !models.IsValidID(req.ParentID) {
		return http.StatusBadRequest, nil, errors.New("invalid parent_id format")
	}
	if status, err := h.validateItemAssignee(r.Context(), noteID, req.AssignedTo); err != nil {
		return status, nil, err
	}

	// The item-count cap is enforced atomically inside the create transaction.
	item, err := h.noteStore.CreateItemWithID(r.Context(), noteID, itemID, req.Text, req.Position, req.Completed, req.ParentID, req.AssignedTo, noteItemsMaxCount)
	if err != nil {
		if errors.Is(err, models.ErrNoteItemExists) {
			return http.StatusConflict, nil, err
		}
		if errors.Is(err, models.ErrNoteItemCapExceeded) {
			return http.StatusBadRequest, nil, fmt.Errorf("note cannot have more than %d items", noteItemsMaxCount)
		}
		if errors.Is(err, models.ErrInvalidParentRef) {
			return http.StatusBadRequest, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("create item: %w", err)
	}

	h.publishItemChangeEvent(r.Context(), noteID, user.ID)
	return http.StatusCreated, item, nil
}

// UpdateNoteItem godoc
//
//	@Summary	Update a single list item
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string					true	"Note ID"
//	@Param		item_id	path		string					true	"Item ID"
//	@Param		body	body		PatchNoteItemRequest	true	"Fields to update"
//	@Success	200		{object}	models.NoteItem
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/items/{item_id} [patch]
func (h *NotesHandler) UpdateNoteItem(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	itemID := chi.URLParam(r, "item_id")
	if !models.IsValidID(noteID) || !models.IsValidID(itemID) {
		return http.StatusBadRequest, nil, errors.New("invalid ID format")
	}

	if _, status, err := h.loadListNoteForItemOp(r.Context(), noteID, user.ID); err != nil {
		return status, nil, err
	}

	var req PatchNoteItemRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if req.Text != nil && utf8.RuneCountInString(*req.Text) > noteItemTextMaxLength {
		return http.StatusBadRequest, nil, fmt.Errorf("item text must be %d characters or fewer", noteItemTextMaxLength)
	}
	if req.ParentID != nil && *req.ParentID != "" && !models.IsValidID(*req.ParentID) {
		return http.StatusBadRequest, nil, errors.New("invalid parent_id format")
	}
	if req.AssignedTo != nil {
		if status, err := h.validateItemAssignee(r.Context(), noteID, *req.AssignedTo); err != nil {
			return status, nil, err
		}
	}

	item, err := h.noteStore.PatchItem(r.Context(), noteID, itemID, models.NoteItemPatch{
		Text:       req.Text,
		Completed:  req.Completed,
		Position:   req.Position,
		ParentID:   req.ParentID,
		AssignedTo: req.AssignedTo,
	})
	if err != nil {
		if errors.Is(err, models.ErrNoteItemNotFound) {
			return http.StatusNotFound, nil, err
		}
		if errors.Is(err, models.ErrInvalidParentRef) {
			return http.StatusBadRequest, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("update item: %w", err)
	}

	h.publishItemChangeEvent(r.Context(), noteID, user.ID)
	return http.StatusOK, item, nil
}

// DeleteNoteItem godoc
//
//	@Summary	Delete a single list item
//	@Tags		notes
//	@Security	CookieAuth
//	@Param		id		path	string	true	"Note ID"
//	@Param		item_id	path	string	true	"Item ID"
//	@Success	204		"no content"
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/items/{item_id} [delete]
func (h *NotesHandler) DeleteNoteItem(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	itemID := chi.URLParam(r, "item_id")
	if !models.IsValidID(noteID) || !models.IsValidID(itemID) {
		return http.StatusBadRequest, nil, errors.New("invalid ID format")
	}

	if _, status, err := h.loadListNoteForItemOp(r.Context(), noteID, user.ID); err != nil {
		return status, nil, err
	}

	if err := h.noteStore.DeleteItemFromNote(r.Context(), noteID, itemID); err != nil {
		if errors.Is(err, models.ErrNoteItemNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("delete item: %w", err)
	}

	h.publishItemChangeEvent(r.Context(), noteID, user.ID)
	return http.StatusNoContent, nil, nil
}

// ReorderNoteItems godoc
//
//	@Summary	Reorder a list note's items
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Param		id		path	string						true	"Note ID"
//	@Param		body	body	ReorderNoteItemsRequest		true	"Ordered item IDs"
//	@Success	204		"no content"
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/items/reorder [post]
func (h *NotesHandler) ReorderNoteItems(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	if !models.IsValidID(noteID) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	if _, status, err := h.loadListNoteForItemOp(r.Context(), noteID, user.ID); err != nil {
		return status, nil, err
	}

	var req ReorderNoteItemsRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}
	if len(req.ItemIDs) == 0 {
		return http.StatusBadRequest, nil, errors.New("empty item IDs list")
	}
	for _, id := range req.ItemIDs {
		if !models.IsValidID(id) {
			return http.StatusBadRequest, nil, errors.New("invalid item ID format")
		}
	}

	if err := h.noteStore.ReorderItems(r.Context(), noteID, req.ItemIDs); err != nil {
		if errors.Is(err, models.ErrNoteItemNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("reorder items: %w", err)
	}

	h.publishItemChangeEvent(r.Context(), noteID, user.ID)
	return http.StatusNoContent, nil, nil
}

// ToggleNoteItemCompleted godoc
//
//	@Summary	Toggle a list item's completed state, cascading to children
//	@Description	Sets the item's completed flag. When the item is a top-level (parent) item, the same value cascades to all of its children atomically. Returns the note's full item list.
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string							true	"Note ID"
//	@Param		item_id	path		string							true	"Item ID"
//	@Param		body	body		ToggleNoteItemCompletedRequest	true	"Completed state"
//	@Success	200		{array}		models.NoteItem
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/items/{item_id}/toggle-completed [post]
func (h *NotesHandler) ToggleNoteItemCompleted(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	itemID := chi.URLParam(r, "item_id")
	if !models.IsValidID(noteID) || !models.IsValidID(itemID) {
		return http.StatusBadRequest, nil, errors.New("invalid ID format")
	}

	if _, status, err := h.loadListNoteForItemOp(r.Context(), noteID, user.ID); err != nil {
		return status, nil, err
	}

	var req ToggleNoteItemCompletedRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}
	if req.Completed == nil {
		return http.StatusBadRequest, nil, errors.New("completed is required")
	}

	items, err := h.noteStore.ToggleItemCompleted(r.Context(), noteID, itemID, *req.Completed)
	if err != nil {
		if errors.Is(err, models.ErrNoteItemNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("toggle item completed: %w", err)
	}

	h.publishItemChangeEvent(r.Context(), noteID, user.ID)
	return http.StatusOK, items, nil
}

// publishItemChangeEvent broadcasts a personalized note_updated event to every
// collaborator after an item-level change. Items are shared content, so each
// audience member receives their own personalized copy of the note (preserving
// per-user state).
func (h *NotesHandler) publishItemChangeEvent(ctx context.Context, noteID, userID string) {
	h.publishUpdateEvent(ctx, noteID, nil, userID, true)
}
