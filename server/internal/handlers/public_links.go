package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/models"
)

// errPublicLinksDisabled answers PUT /notes/{id}/public-link while the
// operator has public links switched off.
var errPublicLinksDisabled = apierr.New(apierr.CodePublicLinksDisabled, "public links are disabled on this server")

// SetPublicLinkRequest is the PUT /notes/{id}/public-link body.
type SetPublicLinkRequest struct {
	// ExpiresAt is when the link stops working (RFC 3339, in the future), or
	// null for a link that never expires.
	ExpiresAt *time.Time `json:"expires_at" extensions:"x-nullable"`
}

// SetPublicLink godoc
//
//	@Summary		Create a note's public link, or change its expiry
//	@Description	Sets the state of the note's public read-only link. With no link, or only an expired one, a link with a new token is created (an expired link is never revived). With an active link only expires_at changes: the token, created_by and created_at stay, so the URL keeps working. Repeating the request has no further effect, so it is safe to retry. To get a new URL, DELETE the link and PUT again. Open to the owner and collaborators. Sends note_updated to everyone with access; the note's version and updated_at do not change.
//	@Tags			sharing
//	@Security		CookieAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		string					true	"Note ID"
//	@Param			body	body		SetPublicLinkRequest	true	"Link expiry"
//	@Success		200		{object}	models.PublicLink
//	@Failure		400		{object}	apierr.ErrorResponse	"bad request, or expires_at not in the future"
//	@Failure		401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		403		{object}	apierr.ErrorResponse	"public links are disabled (public_links_disabled)"
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/public-link [put]
func (h *NotesHandler) SetPublicLink(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	if !h.publicLinksEnabled {
		return http.StatusForbidden, nil, errPublicLinksDisabled
	}

	var req SetPublicLinkRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	var expiresAt *time.Time
	if req.ExpiresAt != nil {
		t := req.ExpiresAt.UTC().Truncate(time.Microsecond)
		if !t.After(models.Now()) {
			return http.StatusBadRequest, nil, errors.New("expires_at must be in the future")
		}
		expiresAt = &t
	}

	// A trashed note's link is paused, so it cannot be created or changed
	// until the note is restored.
	if _, status, err := h.requirePublicLinkAccess(r.Context(), id, user.ID, false); err != nil {
		return status, nil, err
	}

	link, err := h.noteStore.SetPublicLink(r.Context(), id, user.ID, expiresAt)
	if err != nil {
		return storeError(err, "set public link")
	}

	h.events.NoteUpdated(r.Context(), id, nil, user.ID, true)
	return http.StatusOK, link, nil
}

// DeletePublicLink godoc
//
//	@Summary		Revoke a note's public link
//	@Description	Deletes the note's public link, so its URL stops working for everyone who has it. Succeeds when the note has no link, and while public links are switched off, so links can still be cleaned up. Open to the owner and collaborators; the owner can also revoke the link of a trashed note. Sends note_updated to everyone with access when a link was revoked.
//	@Tags			sharing
//	@Security		CookieAuth
//	@Param			id	path	string	true	"Note ID"
//	@Success		204	"no content"
//	@Failure		400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404	{object}	apierr.ErrorResponse	"not found"
//	@Failure		500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/public-link [delete]
func (h *NotesHandler) DeletePublicLink(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	trashed, status, err := h.requirePublicLinkAccess(r.Context(), id, user.ID, true)
	if err != nil {
		return status, nil, err
	}

	deleted, err := h.noteStore.DeletePublicLink(r.Context(), id)
	if err != nil {
		return storeError(err, "delete public link")
	}

	switch {
	case !deleted:
	case trashed:
		// Only the owner sees a trashed note, and the audience fan-out reads
		// active notes only.
		h.events.OwnNoteUpdated(r.Context(), id, user.ID)
	default:
		h.events.NoteUpdated(r.Context(), id, nil, user.ID, true)
	}
	return http.StatusNoContent, nil, nil
}

// requirePublicLinkAccess checks that userID may manage noteID's public link:
// the owner or a collaborator of an active note, or — when allowTrashed is set
// — the owner of a trashed one. Anyone else gets a 404, as for every other
// note endpoint. trashed reports that access came through the trashed-note
// path, where only the owner can see the note.
func (h *NotesHandler) requirePublicLinkAccess(ctx context.Context, noteID, userID string, allowTrashed bool) (trashed bool, status int, err error) {
	hasAccess, err := h.noteStore.HasAccess(ctx, noteID, userID)
	if err != nil {
		return false, http.StatusInternalServerError, fmt.Errorf("check note access: %w", err)
	}
	if hasAccess {
		return false, http.StatusOK, nil
	}
	if allowTrashed {
		isOwner, err := h.noteStore.IsOwner(ctx, noteID, userID)
		if err != nil {
			return false, http.StatusInternalServerError, fmt.Errorf("check note ownership: %w", err)
		}
		if isOwner {
			return true, http.StatusOK, nil
		}
	}
	return false, http.StatusNotFound, models.ErrNoteNotFound
}

// publicToken returns the {token} path parameter, or ErrPublicLinkNotFound
// when public links are switched off. The shape check happens in the store,
// before any query.
func (h *NotesHandler) publicToken(r *http.Request) (string, error) {
	if !h.publicLinksEnabled {
		return "", models.ErrPublicLinkNotFound
	}
	return chi.URLParam(r, "token"), nil
}

// GetPublicNote godoc
//
//	@Summary		Get a note through its public link
//	@Description	Unauthenticated. Returns a reduced, read-only view of the note: no collaborators, labels, color or owner. Unknown, malformed, revoked and expired tokens, a trashed note, and public links being switched off all return the same 404. Rate-limited per client IP (JOT_RATE_LIMIT_PUBLIC_PER_MINUTE, shared with the image endpoints).
//	@Tags			public
//	@Produce		json
//	@Param			token	path		string	true	"Public link token"
//	@Success		200		{object}	models.PublicNote
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		429		{object}	apierr.ErrorResponse	"rate limited"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/public/notes/{token} [get]
func (h *NotesHandler) GetPublicNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	token, err := h.publicToken(r)
	if err != nil {
		return http.StatusNotFound, nil, err
	}

	note, err := h.noteStore.GetPublicNote(r.Context(), token)
	if err != nil {
		return storeError(err, "get public note")
	}
	return http.StatusOK, note, nil
}

// cacheControlPublicImage keeps public images out of shared and long-lived
// caches, so a revoked link's images do not linger in a visitor's browser.
const cacheControlPublicImage = "no-store"

// GetPublicNoteImage godoc
//
//	@Summary		Download an image of a note through its public link
//	@Description	Unauthenticated. Serves only images that belong to the note the token publishes; any other image ID returns the same 404 as a dead link. Not cached.
//	@Tags			public
//	@Produce		image/*,json
//	@Param			token	path		string					true	"Public link token"
//	@Param			id		path		string					true	"Image ID"
//	@Success		200		{file}		binary					"Image bytes"
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		429		{object}	apierr.ErrorResponse	"rate limited"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/public/notes/{token}/images/{id} [get]
func (h *NotesHandler) GetPublicNoteImage(w http.ResponseWriter, r *http.Request) (int, any, error) {
	img, status, err := h.loadPublicNoteImage(r)
	if err != nil {
		return status, nil, err
	}
	return h.serveNoteImage(w, r, img, cacheControlPublicImage, models.ErrPublicLinkNotFound)
}

// GetPublicNoteImageThumbnail godoc
//
//	@Summary		Download an image thumbnail of a note through its public link
//	@Description	Unauthenticated. Serves only thumbnails of images that belong to the note the token publishes; any other image ID returns the same 404 as a dead link. Not cached.
//	@Tags			public
//	@Produce		image/jpeg,json
//	@Param			token	path		string					true	"Public link token"
//	@Param			id		path		string					true	"Image ID"
//	@Success		200		{file}		binary					"Thumbnail JPEG bytes"
//	@Failure		404		{object}	apierr.ErrorResponse	"not found"
//	@Failure		429		{object}	apierr.ErrorResponse	"rate limited"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/public/notes/{token}/images/{id}/thumbnail [get]
func (h *NotesHandler) GetPublicNoteImageThumbnail(w http.ResponseWriter, r *http.Request) (int, any, error) {
	img, status, err := h.loadPublicNoteImage(r)
	if err != nil {
		return status, nil, err
	}
	return h.serveNoteImageThumbnail(w, r, img, cacheControlPublicImage, models.ErrPublicLinkNotFound)
}

func (h *NotesHandler) loadPublicNoteImage(r *http.Request) (*models.NoteImage, int, error) {
	token, err := h.publicToken(r)
	if err != nil {
		return nil, http.StatusNotFound, err
	}
	img, err := h.noteStore.GetPublicNoteImage(r.Context(), token, chi.URLParam(r, "id"))
	if err != nil {
		status, mapped := storeStatus(err, "get public note image")
		return nil, status, mapped
	}
	return img, http.StatusOK, nil
}
