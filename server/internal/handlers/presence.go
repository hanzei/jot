package handlers

import (
	"errors"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/sirupsen/logrus"
)

func (h *NotesHandler) publishPresenceEvent(noteID string, sourceUserID string, eventType sse.EventType) {
	if h.hub == nil {
		return
	}

	audienceIDs, err := h.noteStore.GetNoteAudienceIDs(noteID)
	if err != nil {
		logrus.WithError(err).WithField("note_id", noteID).WithField("event_type", eventType).Error("failed to get note audience for presence event")
		return
	}

	recipients := make([]string, 0, len(audienceIDs))
	for _, audienceID := range audienceIDs {
		if audienceID != sourceUserID {
			recipients = append(recipients, audienceID)
		}
	}
	recipients = slices.Compact(recipients)
	if len(recipients) == 0 {
		return
	}

	h.hub.Publish(recipients, sse.Event{
		Type:         eventType,
		NoteID:       noteID,
		Note:         nil,
		SourceUserID: sourceUserID,
	})
}

// JoinPresence godoc
//
//	@Summary	Join note presence
//	@Tags		presence
//	@Security	CookieAuth
//	@Param		id	path	string	true	"Note ID"
//	@Success	204	"no content"
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/presence/join [post]
func (h *NotesHandler) JoinPresence(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	if noteID == "" {
		return http.StatusBadRequest, nil, errors.New("missing note ID")
	}
	if !models.IsValidID(noteID) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	hasAccess, err := h.noteStore.HasAccess(noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if !hasAccess {
		return http.StatusNotFound, nil, models.ErrNoteNotFound
	}

	h.publishPresenceEvent(noteID, user.ID, sse.EventNoteOpened)
	return http.StatusNoContent, nil, nil
}

// LeavePresence godoc
//
//	@Summary	Leave note presence
//	@Tags		presence
//	@Security	CookieAuth
//	@Param		id	path	string	true	"Note ID"
//	@Success	204	"no content"
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/presence/leave [post]
func (h *NotesHandler) LeavePresence(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	if noteID == "" {
		return http.StatusBadRequest, nil, errors.New("missing note ID")
	}
	if !models.IsValidID(noteID) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	hasAccess, err := h.noteStore.HasAccess(noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if !hasAccess {
		return http.StatusNotFound, nil, models.ErrNoteNotFound
	}

	h.publishPresenceEvent(noteID, user.ID, sse.EventNoteClosed)
	return http.StatusNoContent, nil, nil
}
