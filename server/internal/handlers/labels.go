package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
)

type LabelsHandler struct {
	noteStore *models.NoteStore
	hub       *sse.Hub
}

func NewLabelsHandler(noteStore *models.NoteStore, hub *sse.Hub) *LabelsHandler {
	return &LabelsHandler{
		noteStore: noteStore,
		hub:       hub,
	}
}

type AddLabelRequest struct {
	Name string `json:"name"`
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
func (h *LabelsHandler) GetLabels(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	labels, err := h.noteStore.GetLabels(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if labels == nil {
		labels = []models.Label{}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(labels); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/labels [post]
func (h *LabelsHandler) AddLabel(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")

	var req AddLabelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, errors.New("invalid request body")
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return http.StatusBadRequest, errors.New("label name is required")
	}

	label, err := h.noteStore.GetOrCreateLabel(user.ID, req.Name)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if err = h.noteStore.AddLabelToNote(noteID, label.ID, user.ID); err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, errors.New("no access to note")
		}
		return http.StatusInternalServerError, err
	}

	note, err := h.noteStore.GetByID(noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if h.hub != nil {
		audienceIDs, audErr := h.noteStore.GetNoteAudienceIDs(noteID)
		if audErr == nil {
			h.hub.Publish(audienceIDs, sse.Event{
				Type:         sse.EventNoteUpdated,
				NoteID:       noteID,
				Note:         note,
				SourceUserID: user.ID,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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
func (h *LabelsHandler) RemoveLabel(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	labelID := chi.URLParam(r, "label_id")

	if err := h.noteStore.RemoveLabelFromNote(noteID, labelID, user.ID); err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, errors.New("no access to note")
		}
		return http.StatusInternalServerError, err
	}

	note, err := h.noteStore.GetByID(noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if h.hub != nil {
		audienceIDs, audErr := h.noteStore.GetNoteAudienceIDs(noteID)
		if audErr == nil {
			h.hub.Publish(audienceIDs, sse.Event{
				Type:         sse.EventNoteUpdated,
				NoteID:       noteID,
				Note:         note,
				SourceUserID: user.ID,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}
