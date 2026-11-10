package handlers

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/hanzei/jot/server/internal/models"
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
//	@Failure	400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403	{object}	apierr.ErrorResponse	"not owner"
//	@Failure	404	{object}	apierr.ErrorResponse	"not found"
//	@Failure	409	{object}	apierr.ErrorResponse	"already shared"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/share [post]
func (h *NotesHandler) ShareNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req ShareNoteRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := h.notes.Share(r.Context(), id, user.ID, req.UserID); err != nil {
		return storeError(err, "share note")
	}

	return http.StatusNoContent, nil, nil
}

// UnshareNote godoc
//
//	@Summary		Remove a share from a note
//	@Description	Owners may remove any collaborator; collaborators may remove only themselves (leave the note).
//	@Tags			sharing
//	@Security		CookieAuth
//	@Param			id		path	string	true	"Note ID"
//	@Param			user_id	path	string	true	"User ID to unshare with"
//	@Success		204
//	@Failure		400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		403	{object}	apierr.ErrorResponse	"forbidden"
//	@Failure		404	{object}	apierr.ErrorResponse	"not found"
//	@Failure		500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/shares/{user_id} [delete]
func (h *NotesHandler) UnshareNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	userID, idErr := pathID(r, "user_id", "user")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	if err := h.notes.Unshare(r.Context(), id, user.ID, userID); err != nil {
		return storeError(err, "unshare note")
	}

	return http.StatusNoContent, nil, nil
}

// NoteShareListResponse is the GET /notes/{id}/shares body.
type NoteShareListResponse struct {
	Shares []models.NoteShare `json:"shares"`
}

// GetNoteShares godoc
//
//	@Summary	List users a note is shared with
//	@Tags		sharing
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"Note ID"
//	@Success	200	{object}	NoteShareListResponse
//	@Failure	400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403	{object}	apierr.ErrorResponse	"no access"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/shares [get]
func (h *NotesHandler) GetNoteShares(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	// Anyone with access to the note may see who it is shared with: the owner
	// and every collaborator. Only owners can change shares (see ShareNote and
	// UnshareNote), but the collaborator list is shared context, not a secret.
	hasAccess, err := h.noteStore.HasAccess(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("check note access: %w", err)
	}
	if !hasAccess {
		return http.StatusForbidden, nil, errors.New("no access")
	}

	shares, err := h.noteStore.GetNoteShares(r.Context(), id)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get note shares: %w", err)
	}

	return http.StatusOK, NoteShareListResponse{Shares: shares}, nil
}
