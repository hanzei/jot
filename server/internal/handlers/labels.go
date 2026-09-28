package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notify"
	"github.com/hanzei/jot/server/internal/sse"
)

type LabelsHandler struct {
	noteStore  *models.NoteStore
	labelStore *models.LabelStore
	events     *notify.Publisher
}

func NewLabelsHandler(noteStore *models.NoteStore, labelStore *models.LabelStore, hub *sse.Hub) *LabelsHandler {
	return &LabelsHandler{
		noteStore:  noteStore,
		labelStore: labelStore,
		events:     notify.New(hub, noteStore),
	}
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

// LabelCount is the note count for a single label.
type LabelCount struct {
	LabelID string `json:"label_id"`
	Count   int    `json:"count"`
}

// LabelCountsResponse is an extensible envelope wrapping per-label note counts.
type LabelCountsResponse struct {
	Counts []LabelCount `json:"counts"`
}

// LabelListResponse is the GET /labels body.
type LabelListResponse struct {
	Labels []models.Label `json:"labels"`
}

// GetLabels godoc
//
//	@Summary	List all labels for the current user
//	@Tags		labels
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	LabelListResponse
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/labels [get]
func (h *LabelsHandler) GetLabels(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	labels, err := h.labelStore.GetLabels(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get labels: %w", err)
	}

	return http.StatusOK, LabelListResponse{Labels: labels}, nil
}

// GetLabelCounts godoc
//
//	@Summary	Get note counts per label for the current user
//	@Tags		labels
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	LabelCountsResponse
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/labels/counts [get]
func (h *LabelsHandler) GetLabelCounts(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	counts, err := h.labelStore.GetLabelCounts(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get label counts: %w", err)
	}

	labelIDs := make([]string, 0, len(counts))
	for labelID := range counts {
		labelIDs = append(labelIDs, labelID)
	}
	sort.Strings(labelIDs)

	resp := LabelCountsResponse{Counts: make([]LabelCount, 0, len(counts))}
	for _, labelID := range labelIDs {
		resp.Counts = append(resp.Counts, LabelCount{LabelID: labelID, Count: counts[labelID]})
	}

	return http.StatusOK, resp, nil
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
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	var req AddLabelRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return http.StatusBadRequest, nil, errors.New("label name is required")
	}

	var (
		label   *models.Label
		created bool
		err     error
	)
	if req.ID != "" {
		var status int
		label, status, err = h.createLabelWithID(r.Context(), user.ID, req.ID, req.Name)
		if err != nil {
			return status, nil, err
		}
		// A client-supplied ID means a real create: a name match on an existing
		// label is a 409, never a silent hand-back.
		created = true
	} else {
		label, created, err = h.labelStore.GetOrCreateLabel(r.Context(), user.ID, req.Name)
		if err != nil {
			// An overlong name still matches an existing label; only a new
			// one is rejected.
			if errors.Is(err, models.ErrLabelNameTooLong) {
				return http.StatusUnprocessableEntity, nil, err
			}
			return http.StatusInternalServerError, nil, fmt.Errorf("get or create label: %w", err)
		}
	}

	// Best-effort realtime update for other sessions of the same user.
	h.events.LabelsChanged(r.Context(), user.ID, label)

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

// createLabelWithID is CreateLabel's strict-create path for a client-supplied
// ID, returning the HTTP status to surface on failure.
func (h *LabelsHandler) createLabelWithID(ctx context.Context, userID, id, name string) (*models.Label, int, error) {
	if !models.IsValidID(id) {
		return nil, http.StatusBadRequest, errors.New("invalid label ID format")
	}
	label, err := h.labelStore.CreateLabel(ctx, userID, id, name)
	switch {
	case err == nil:
		return label, http.StatusCreated, nil
	case errors.Is(err, models.ErrLabelIDConflict):
		return nil, http.StatusConflict, errors.New("label already exists")
	case errors.Is(err, models.ErrLabelNameConflict):
		return nil, http.StatusConflict, models.ErrLabelNameConflict
	case errors.Is(err, models.ErrLabelNameTooLong):
		return nil, http.StatusUnprocessableEntity, err
	default:
		return nil, http.StatusInternalServerError, fmt.Errorf("create label: %w", err)
	}
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
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	labelID := chi.URLParam(r, "id")

	var req RenameLabelRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return http.StatusBadRequest, nil, errors.New("label name is required")
	}
	if err := models.ValidateLabelName(req.Name); err != nil {
		return http.StatusUnprocessableEntity, nil, err
	}

	noteIDs, err := h.labelStore.GetLabelNoteIDs(r.Context(), labelID, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("get label note IDs: %w", err)
	}

	label, err := h.labelStore.RenameLabel(r.Context(), labelID, user.ID, req.Name)
	if err != nil {
		if errors.Is(err, models.ErrLabelNameConflict) {
			return http.StatusBadRequest, nil, models.ErrLabelNameConflict
		}
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("rename label: %w", err)
	}

	h.events.LabelNoteUpdates(r.Context(), noteIDs, user.ID)

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
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")

	var req AddLabelRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return http.StatusBadRequest, nil, errors.New("label name is required")
	}

	label, _, err := h.labelStore.GetOrCreateLabel(r.Context(), user.ID, req.Name)
	if err != nil {
		if errors.Is(err, models.ErrLabelNameTooLong) {
			return http.StatusUnprocessableEntity, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("get or create label: %w", err)
	}

	if err = h.noteStore.AddLabelToNote(r.Context(), noteID, label.ID, user.ID); err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, errors.New("no access to note")
		}
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("add label to note: %w", err)
	}

	note, err := h.noteStore.GetByID(r.Context(), noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get note: %w", err)
	}

	// Labels are per-user, so only the acting user's view of the note changed.
	h.events.NoteUpdated(r.Context(), noteID, note, user.ID, false)

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
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	labelID := chi.URLParam(r, "label_id")

	if err := h.noteStore.RemoveLabelFromNote(r.Context(), noteID, labelID, user.ID); err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, errors.New("no access to note")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("remove label from note: %w", err)
	}

	note, err := h.noteStore.GetByID(r.Context(), noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get note: %w", err)
	}

	// Labels are per-user, so only the acting user's view of the note changed.
	h.events.NoteUpdated(r.Context(), noteID, note, user.ID, false)

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
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	labelID := chi.URLParam(r, "id")
	noteIDs, err := h.labelStore.GetLabelNoteIDs(r.Context(), labelID, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("get label note IDs: %w", err)
	}
	if err := h.labelStore.DeleteLabel(r.Context(), labelID, user.ID); err != nil {
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("delete label: %w", err)
	}

	h.events.LabelNoteUpdates(r.Context(), noteIDs, user.ID)

	return http.StatusNoContent, nil, nil
}
