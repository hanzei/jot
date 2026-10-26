package handlers

import (
	"net/http"

	"github.com/hanzei/jot/server/internal/models"
)

// NoteRevisionListResponse is the GET /notes/{id}/revisions body.
type NoteRevisionListResponse struct {
	Revisions []models.NoteRevisionSummary `json:"revisions"`
}

// RestoreNoteRevisionRequest is the body for
// POST /notes/{id}/revisions/{revision_id}/restore.
type RestoreNoteRevisionRequest struct {
	// BaseVersion enables optimistic concurrency, matching UpdateNoteRequest:
	// when set, the restore is rejected with 409 unless the note's current
	// version still matches it.
	BaseVersion *int `json:"base_version,omitempty"`
}

// ListNoteRevisions godoc
//
//	@Summary		List a note's revisions
//	@Description	Metadata only, newest first. A revision is the note's shared content (type, title, content, items) as it was just before a write replaced it; writes from one user and client within 10 minutes coalesce into one revision. Images are not part of a revision. A note keeps at most 50 revisions, for at most 90 days.
//	@Tags			notes
//	@Security		CookieAuth
//	@Produce		json
//	@Param			id	path		string	true	"Note ID"
//	@Success		200	{object}	NoteRevisionListResponse
//	@Failure		400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404	{object}	apierr.ErrorResponse	"not found"
//	@Failure		500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/revisions [get]
func (h *NotesHandler) ListNoteRevisions(_ http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	revisions, err := h.noteStore.ListRevisions(r.Context(), id, user.ID)
	if err != nil {
		return storeError(err, "list note revisions")
	}
	return http.StatusOK, NoteRevisionListResponse{Revisions: revisions}, nil
}

// GetNoteRevision godoc
//
//	@Summary	Get one revision of a note
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id			path		string	true	"Note ID"
//	@Param		revision_id	path		string	true	"Revision ID"
//	@Success	200			{object}	models.NoteRevision
//	@Failure	400			{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401			{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404			{object}	apierr.ErrorResponse	"not found"
//	@Failure	500			{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/revisions/{revision_id} [get]
func (h *NotesHandler) GetNoteRevision(_ http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}
	revisionID, idErr := pathID(r, "revision_id", "revision")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	revision, err := h.noteStore.GetRevision(r.Context(), id, revisionID, user.ID)
	if err != nil {
		return storeError(err, "get note revision")
	}
	return http.StatusOK, revision, nil
}

// RestoreNoteRevision godoc
//
//	@Summary		Restore a revision of a note
//	@Description	An ordinary content write: it replaces the note's shared content with the revision's, converting the note back when the revision has another type, and records the content it replaces as a new revision, so a restore can itself be undone. Restored list items keep their IDs; an item's assignee is restored only if they can still access the note.
//	@Tags			notes
//	@Security		CookieAuth
//	@Accept			json
//	@Produce		json
//	@Param			id			path		string						true	"Note ID"
//	@Param			revision_id	path		string						true	"Revision ID"
//	@Param			body		body		RestoreNoteRevisionRequest	true	"Version the restore is based on"
//	@Success		200			{object}	models.Note
//	@Failure		400			{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401			{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404			{object}	apierr.ErrorResponse	"not found"
//	@Failure		409			{object}	apierr.ErrorResponse	"version conflict: note changed since base_version"
//	@Failure		500			{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/revisions/{revision_id}/restore [post]
func (h *NotesHandler) RestoreNoteRevision(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}
	revisionID, idErr := pathID(r, "revision_id", "revision")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req RestoreNoteRevisionRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	restored, err := h.noteStore.RestoreRevision(r.Context(), id, revisionID, user.ID, req.BaseVersion)
	if err != nil {
		return storeError(err, "restore note revision")
	}

	sanitized := models.SanitizeNote(*restored)
	h.events.NoteUpdated(r.Context(), id, &sanitized, user.ID, true)
	h.notesUpdated.Add(r.Context(), 1)
	return http.StatusOK, sanitized, nil
}
