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

func (h *LabelsHandler) publishLabelNoteUpdates(noteIDs []string, userID string) {
	if h.hub == nil {
		return
	}

	for _, noteID := range noteIDs {
		note, err := h.noteStore.GetByIDAnyState(noteID, userID)
		if err != nil {
			continue
		}

		audienceIDs, err := h.noteStore.GetNoteAudienceIDs(noteID)
		if err != nil {
			continue
		}

		h.hub.Publish(audienceIDs, sse.Event{
			Type:         sse.EventNoteUpdated,
			NoteID:       noteID,
			Note:         note,
			SourceUserID: userID,
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

	labels, err := h.labelStore.GetLabels(user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
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

	noteIDs, err := h.labelStore.GetLabelNoteIDs(labelID, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, err
	}

	label, err := h.labelStore.RenameLabel(labelID, user.ID, req.Name)
	if err != nil {
		if errors.Is(err, models.ErrLabelNameConflict) {
			return http.StatusBadRequest, nil, errors.New("label name already exists")
		}
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, err
	}

	h.publishLabelNoteUpdates(noteIDs, user.ID)

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

	label, err := h.labelStore.GetOrCreateLabel(user.ID, req.Name)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	if err = h.noteStore.AddLabelToNote(noteID, label.ID, user.ID); err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, errors.New("no access to note")
		}
		return http.StatusInternalServerError, nil, err
	}

	note, err := h.noteStore.GetByID(noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
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

	if err := h.noteStore.RemoveLabelFromNote(noteID, labelID, user.ID); err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, errors.New("no access to note")
		}
		return http.StatusInternalServerError, nil, err
	}

	note, err := h.noteStore.GetByID(noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
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
	noteIDs, err := h.labelStore.GetLabelNoteIDs(labelID, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, err
	}
	if err := h.labelStore.DeleteLabel(labelID, user.ID); err != nil {
		if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
			return http.StatusNotFound, nil, errors.New("label not found")
		}
		return http.StatusInternalServerError, nil, err
	}

	h.publishLabelNoteUpdates(noteIDs, user.ID)

	return http.StatusNoContent, nil, nil
}
