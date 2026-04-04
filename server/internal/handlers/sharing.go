package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
)

type ShareNoteRequest struct {
	UserID string `json:"user_id"`
}

// ShareNote godoc
//
//	@Summary	Share a note with another user
//	@Tags		sharing
//	@Security	CookieAuth
//	@Accept		json
//	@Param		id		path	string				true	"Note ID"
//	@Param		body	body	ShareNoteRequest	true	"User ID to share with"
//	@Success	204
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"not owner"
//	@Failure	404	{string}	string	"not found"
//	@Failure	409	{string}	string	"already shared"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/share [post]
func (h *NotesHandler) ShareNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, nil, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	var req ShareNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if !models.IsValidID(req.UserID) {
		return http.StatusBadRequest, nil, errors.New("invalid user_id")
	}

	isOwner, err := h.noteStore.IsOwner(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if !isOwner {
		return http.StatusForbidden, nil, errors.New("not owner")
	}

	if req.UserID == user.ID {
		return http.StatusBadRequest, nil, errors.New("cannot share with self")
	}

	if _, lookupErr := h.userStore.GetByID(r.Context(), req.UserID); lookupErr != nil {
		if errors.Is(lookupErr, models.ErrUserNotFound) {
			return http.StatusNotFound, nil, lookupErr
		}
		return http.StatusInternalServerError, nil, lookupErr
	}

	err = h.noteStore.ShareNote(r.Context(), id, user.ID, req.UserID)
	if err != nil {
		if errors.Is(err, models.ErrNoteAlreadyShared) {
			return http.StatusConflict, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	// Fetch the note to include in the SSE payload; audience now includes the new target.
	if sharedNote, err := h.noteStore.GetByID(r.Context(), id, user.ID); err == nil {
		h.publishNoteEvent(r.Context(), id, sse.EventNoteShared, sharedNote, user.ID)
	}

	return http.StatusNoContent, nil, nil
}

// UnshareNote godoc
//
//	@Summary	Remove a share from a note
//	@Tags		sharing
//	@Security	CookieAuth
//	@Param		id		path	string	true	"Note ID"
//	@Param		user_id	path	string	true	"User ID to unshare with"
//	@Success	204
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"not owner"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/shares/{user_id} [delete]
func (h *NotesHandler) UnshareNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, nil, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	userID := chi.URLParam(r, "user_id")
	if userID == "" {
		return http.StatusBadRequest, nil, errors.New("missing user_id")
	}

	if !models.IsValidID(userID) {
		return http.StatusBadRequest, nil, errors.New("invalid user_id")
	}

	isOwner, err := h.noteStore.IsOwner(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if !isOwner {
		return http.StatusForbidden, nil, errors.New("not owner")
	}

	// Fetch audience before unsharing so the target user is still in the list.
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(r.Context(), id)

	err = h.noteStore.UnshareNote(r.Context(), id, userID)
	if err != nil {
		if errors.Is(err, models.ErrNoteShareNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	if audienceErr == nil && h.hub != nil {
		h.hub.Publish(audienceIDs, sse.Event{
			Type:         sse.EventNoteUnshared,
			SourceUserID: user.ID,
			TargetUserID: userID,
			Data:         sse.NoteEventData{NoteID: id},
		})
	}

	return http.StatusNoContent, nil, nil
}

// GetNoteShares godoc
//
//	@Summary	List users a note is shared with
//	@Tags		sharing
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"Note ID"
//	@Success	200	{array}		models.NoteShare
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"not owner"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/shares [get]
func (h *NotesHandler) GetNoteShares(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, nil, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	isOwner, err := h.noteStore.IsOwner(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if !isOwner {
		return http.StatusForbidden, nil, errors.New("not owner")
	}

	shares, err := h.noteStore.GetNoteShares(r.Context(), id)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusOK, shares, nil
}
