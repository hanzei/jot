package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
)

type LabelsHandler struct {
	noteStore  *models.NoteStore
	labelStore *models.LabelStore
	hub        *sse.Hub
}

func NewLabelsHandler(noteStore *models.NoteStore, labelStore *models.LabelStore, hub *sse.Hub) *LabelsHandler {
	return &LabelsHandler{
		noteStore:  noteStore,
		labelStore: labelStore,
		hub:        hub,
	}
}

type AddLabelRequest struct {
	Name string `json:"name"`
}

type RenameLabelRequest struct {
	Name string `json:"name"`
}

func (h *LabelsHandler) publishLabelNoteUpdates(ctx context.Context, noteIDs []string, userID string) {
	if h.hub == nil {
		return
	}

	// Labels are per-user: only the acting user's view changes, so we publish only to them.
	for _, noteID := range noteIDs {
		note, err := h.noteStore.GetByIDAnyState(ctx, noteID, userID)
		if err != nil {
			continue
		}

		h.hub.Publish(ctx, []string{userID}, sse.Event{
			Type:         sse.EventNoteUpdated,
			SourceUserID: userID,
			Data:         sse.NoteEventData{NoteID: noteID, Note: note},
		})
	}
}

// GetLabels godoc
//
//	@Summary	List all labels for the current user
//	@Tags		labels
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{array}		models.Label
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	500	{string}	string	"internal server error"
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

	return http.StatusOK, labels, nil
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
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"label not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/labels/{id} [patch]
func (h *LabelsHandler) RenameLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	labelID := chi.URLParam(r, "id")

	var req RenameLabelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return http.StatusBadRequest, nil, errors.New("label name is required")
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
			return http.StatusBadRequest, nil, errors.New("label name already exists")
		}
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("rename label: %w", err)
	}

	h.publishLabelNoteUpdates(r.Context(), noteIDs, user.ID)

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
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"no access to note"
//	@Failure	404		{string}	string	"label not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/labels [post]
func (h *LabelsHandler) AddLabel(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")

	var req AddLabelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid request body")
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return http.StatusBadRequest, nil, errors.New("label name is required")
	}

	label, err := h.labelStore.GetOrCreateLabel(r.Context(), user.ID, req.Name)
	if err != nil {
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

	if h.hub != nil {
		h.hub.Publish(r.Context(), []string{user.ID}, sse.Event{
			Type:         sse.EventNoteUpdated,
			SourceUserID: user.ID,
			Data:         sse.NoteEventData{NoteID: noteID, Note: note},
		})
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
//	@Failure	401			{string}	string	"unauthorized"
//	@Failure	403			{string}	string	"no access to note"
//	@Failure	500			{string}	string	"internal server error"
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

	if h.hub != nil {
		h.hub.Publish(r.Context(), []string{user.ID}, sse.Event{
			Type:         sse.EventNoteUpdated,
			SourceUserID: user.ID,
			Data:         sse.NoteEventData{NoteID: noteID, Note: note},
		})
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
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"label not found"
//	@Failure	500	{string}	string	"internal server error"
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

	h.publishLabelNoteUpdates(r.Context(), noteIDs, user.ID)

	return http.StatusNoContent, nil, nil
}
