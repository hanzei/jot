package handlers

import (
	"errors"
	"net/http"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notesvc"
)

// CreateNoteItemRequest is the body for POST /notes/{id}/items. The client
// supplies the item ID so the new item has a stable identity for subsequent
// per-item updates and offline replay; if omitted, the server generates one.
type CreateNoteItemRequest struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	// Position is where the item goes in the note's order. The server may
	// store a different one: after the insert it re-sequences the note so
	// every child sorts directly after its parent, so read the stored value
	// from the response.
	Position  int  `json:"position"`
	Completed bool `json:"completed"`
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
	// Position, when present, moves the item. As with parent_id, the server
	// then re-sequences the note so every child sorts directly after its
	// parent, so the stored position (in the response) may differ.
	Position *int `json:"position"`
	// ParentID, when present, re-parents the item ("" makes it top-level).
	ParentID   *string `json:"parent_id"`
	AssignedTo *string `json:"assigned_to"`
}

// ReorderNoteItemsRequest is the body for POST /notes/{id}/items/reorder.
type ReorderNoteItemsRequest struct {
	ItemIDs []string `json:"item_ids"`
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
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"not found"
//	@Failure	409		{object}	apierr.ErrorResponse	"item already exists"
//	@Failure	422		{object}	apierr.ErrorResponse	"note item cap exceeded (item_limit_reached)"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/items [post]
func (h *NotesHandler) CreateNoteItem(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req CreateNoteItemRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	item, err := h.notes.CreateItem(r.Context(), noteID, user.ID, notesvc.NewListItem{
		ID:         req.ID,
		Text:       req.Text,
		Position:   &req.Position,
		Completed:  req.Completed,
		ParentID:   req.ParentID,
		AssignedTo: req.AssignedTo,
	})
	if err != nil {
		return storeError(err, "create item")
	}
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
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"not found"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/items/{item_id} [patch]
func (h *NotesHandler) UpdateNoteItem(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}
	itemID, idErr := pathID(r, "item_id", "item")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req PatchNoteItemRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	item, err := h.notes.PatchItem(r.Context(), noteID, user.ID, itemID, models.NoteItemPatch{
		Text:       req.Text,
		Completed:  req.Completed,
		Position:   req.Position,
		ParentID:   req.ParentID,
		AssignedTo: req.AssignedTo,
	})
	if err != nil {
		return storeError(err, "update item")
	}
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
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"not found"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/items/{item_id} [delete]
func (h *NotesHandler) DeleteNoteItem(_ http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}
	itemID, idErr := pathID(r, "item_id", "item")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	if err := h.notes.DeleteItem(r.Context(), noteID, user.ID, itemID); err != nil {
		return storeError(err, "delete item")
	}
	return http.StatusNoContent, nil, nil
}

// ReorderNoteItems godoc
//
//	@Summary		Reorder a list note's items
//	@Description	Sets each item's position to its index in item_ids, then re-sequences the note so every child sorts directly after its parent: an order that separates a child from its parent keeps the group together and the requested order within it.
//	@Tags			notes
//	@Security		CookieAuth
//	@Accept			json
//	@Param			id		path	string					true	"Note ID"
//	@Param			body	body	ReorderNoteItemsRequest	true	"Ordered item IDs"
//	@Success		204		"no content"
//	@Failure		400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/items/reorder [post]
func (h *NotesHandler) ReorderNoteItems(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req ReorderNoteItemsRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := h.notes.ReorderItems(r.Context(), noteID, user.ID, req.ItemIDs); err != nil {
		return storeError(err, "reorder items")
	}
	return http.StatusNoContent, nil, nil
}

// SetNoteItemsCompletedRequest is the body for POST /notes/{id}/items/set-completed.
type SetNoteItemsCompletedRequest struct {
	ItemIDs []string `json:"item_ids" validate:"required"`
	// Completed is a pointer so an omitted field is rejected rather than
	// silently decoding to false.
	Completed *bool `json:"completed" validate:"required"`
}

// DeleteNoteItemsRequest is the body for POST /notes/{id}/items/delete.
type DeleteNoteItemsRequest struct {
	ItemIDs []string `json:"item_ids" validate:"required"`
}

// SetNoteItemsCompleted godoc
//
//	@Summary		Set the completed flag on one or more list items, cascading to children
//	@Description	Sets completed to the given value on each of the named items and returns the note's full item list. Each item that is checked or unchecked applies the parent/child cascade: a top-level (parent) item carries the same value to all of its children, and unchecking a child also unchecks its parent. A single tap is a one-element item_ids; bulk "uncheck all" (completed=false) and its undo (completed=true) pass the whole set. IDs that do not belong to the note are ignored, so a stale tap on a since-deleted item returns 200 with the current list.
//	@Tags			notes
//	@Security		CookieAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		string							true	"Note ID"
//	@Param			body	body		SetNoteItemsCompletedRequest	true	"Item IDs and target completed state"
//	@Success		200		{array}		models.NoteItem
//	@Failure		400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/items/set-completed [post]
func (h *NotesHandler) SetNoteItemsCompleted(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req SetNoteItemsCompletedRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}
	if req.Completed == nil {
		return http.StatusBadRequest, nil, errors.New("completed is required")
	}

	items, err := h.notes.SetItemsCompleted(r.Context(), noteID, user.ID, req.ItemIDs, *req.Completed)
	if err != nil {
		return storeError(err, "set items completed")
	}
	return http.StatusOK, items, nil
}

// DeleteNoteItems godoc
//
//	@Summary		Delete a set of list items
//	@Description	Deletes each of the named items and returns the note's remaining items. Used for bulk "delete checked items"; the caller passes the item IDs it captured.
//	@Tags			notes
//	@Security		CookieAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		string					true	"Note ID"
//	@Param			body	body		DeleteNoteItemsRequest	true	"Item IDs to delete"
//	@Success		200		{array}		models.NoteItem
//	@Failure		400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/items/delete [post]
func (h *NotesHandler) DeleteNoteItems(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req DeleteNoteItemsRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	items, err := h.notes.DeleteItems(r.Context(), noteID, user.ID, req.ItemIDs)
	if err != nil {
		return storeError(err, "delete items")
	}
	return http.StatusOK, items, nil
}
