package handlers

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notesvc"
)

type LabelsHandler struct {
	labelStore *models.LabelStore
	notes      *notesvc.Service
}

func NewLabelsHandler(labelStore *models.LabelStore, notes *notesvc.Service) *LabelsHandler {
	return &LabelsHandler{labelStore: labelStore, notes: notes}
}

type AddLabelRequest struct {
	// ID is an optional client-supplied label ID. When provided it is used as the
	// label's primary key so an offline-created label can be replayed idempotently:
	// a replay whose original create already committed is rejected with 409
	// instead of inserting a duplicate. When empty the server generates one.
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
}

type RenameLabelRequest struct {
	Name string `json:"name"`
}

// LabelListResponse is the GET /labels body.
type LabelListResponse struct {
	Labels []models.LabelWithCount `json:"labels"`
}

// GetLabels godoc
//
//	@Summary		List all labels for the current user
//	@Description	Each label carries note_count: the number of non-trashed, non-archived notes carrying the label for the requesting user.
//	@Tags			labels
//	@Security		CookieAuth
//	@Produce		json
//	@Success		200	{object}	LabelListResponse
//	@Failure		401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/labels [get]
func (h *LabelsHandler) GetLabels(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	labels, err := h.labelStore.GetLabels(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get labels: %w", err)
	}

	return http.StatusOK, LabelListResponse{Labels: labels}, nil
}

// CreateLabel godoc
//
//	@Summary	Create a label, or return the existing one when no ID is supplied
//	@Tags		labels
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		AddLabelRequest			true	"Label name and optional client-supplied ID"
//	@Success	200		{object}	models.Label			"an existing label with that name was returned unchanged"
//	@Success	201		{object}	models.Label			"a new label was created"
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	409		{object}	apierr.ErrorResponse	"label already exists"
//	@Failure	422		{object}	apierr.ErrorResponse	"label name too long (label_name_too_long)"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/labels [post]
func (h *LabelsHandler) CreateLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	var req AddLabelRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	label, created, err := h.notes.CreateLabel(r.Context(), user.ID, req.ID, req.Name)
	switch {
	case errors.Is(err, models.ErrLabelIDConflict):
		return http.StatusConflict, nil, errors.New("label already exists")
	case errors.Is(err, models.ErrLabelNameConflict):
		// Only a create with a client-supplied ID is strict about names.
		return http.StatusConflict, nil, err
	case err != nil:
		return storeError(err, "create label")
	}

	// 201 when a label was inserted, 200 when an existing one was returned
	// unchanged. Without an ID this endpoint is get-or-create — the webapp and
	// mobile add labels by typing a name, and offline replay needs the create to
	// be idempotent — so which of the two happened is not knowable from the
	// request alone, and the status code is what tells the client.
	if created {
		return http.StatusCreated, label, nil
	}
	return http.StatusOK, label, nil
}

// RenameLabel godoc
//
//	@Summary	Rename a label
//	@Tags		labels
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string				true	"Label ID"
//	@Param		body	body		RenameLabelRequest	true	"New label name"
//	@Success	200		{object}	models.Label
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"label not found"
//	@Failure	422		{object}	apierr.ErrorResponse	"label name too long (label_name_too_long)"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/labels/{id} [patch]
func (h *LabelsHandler) RenameLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	labelID := chi.URLParam(r, "id")

	var req RenameLabelRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	label, err := h.notes.RenameLabel(r.Context(), labelID, user.ID, req.Name)
	if errors.Is(err, models.ErrLabelNameConflict) {
		return http.StatusBadRequest, nil, err
	}
	if err != nil {
		return labelError(err, "rename label")
	}
	return http.StatusOK, label, nil
}

// AddLabel godoc
//
//	@Summary	Add a label to a note
//	@Tags		labels
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string			true	"Note ID"
//	@Param		body	body		AddLabelRequest	true	"Label name"
//	@Success	200		{object}	models.Note
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403		{object}	apierr.ErrorResponse	"no access to note"
//	@Failure	404		{object}	apierr.ErrorResponse	"label not found"
//	@Failure	422		{object}	apierr.ErrorResponse	"label name too long (label_name_too_long)"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/labels [post]
func (h *LabelsHandler) AddLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID := chi.URLParam(r, "id")

	var req AddLabelRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	note, err := h.notes.AddLabelToNote(r.Context(), noteID, user.ID, req.Name)
	if err != nil {
		return labelError(err, "add label to note")
	}
	return http.StatusOK, note, nil
}

// RemoveLabel godoc
//
//	@Summary	Remove a label from a note
//	@Tags		labels
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id			path		string	true	"Note ID"
//	@Param		label_id	path		string	true	"Label ID"
//	@Success	200			{object}	models.Note
//	@Failure	401			{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403			{object}	apierr.ErrorResponse	"no access to note"
//	@Failure	500			{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/labels/{label_id} [delete]
func (h *LabelsHandler) RemoveLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	noteID := chi.URLParam(r, "id")
	labelID := chi.URLParam(r, "label_id")

	note, err := h.notes.RemoveLabelFromNote(r.Context(), noteID, labelID, user.ID)
	if err != nil {
		return labelError(err, "remove label from note")
	}
	return http.StatusOK, note, nil
}

// DeleteLabel godoc
//
//	@Summary	Delete a label
//	@Tags		labels
//	@Security	CookieAuth
//	@Param		id	path	string	true	"Label ID"
//	@Success	204
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404	{object}	apierr.ErrorResponse	"label not found"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/labels/{id} [delete]
func (h *LabelsHandler) DeleteLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	if err := h.notes.DeleteLabel(r.Context(), chi.URLParam(r, "id"), user.ID); err != nil {
		return labelError(err, "delete label")
	}
	return http.StatusNoContent, nil, nil
}

// labelError maps a label operation's error to a response. The label routes
// differ from apierr's sentinel table in two places: a missing label reads
// "label not found", and a note the user cannot reach is a 403 rather than
// the 404 the note routes return.
func labelError(err error, op string) (int, any, error) {
	switch {
	case errors.Is(err, models.ErrLabelNotFoundOrNotOwned):
		return http.StatusNotFound, nil, errors.New("label not found")
	case errors.Is(err, models.ErrNoteNoAccess):
		return http.StatusForbidden, nil, errors.New("no access to note")
	}
	return storeError(err, op)
}
