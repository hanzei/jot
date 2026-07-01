package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
)

// Keep in sync with shared/src/constants.ts IMAGE_MAX_PER_NOTE / IMAGE_ALLOWED_TYPES.
// No image/svg+xml: SVG can carry script and would be a stored-XSS vector
// when rendered inline (see docs/specs/file-attachments.md §7).
const imageMaxPerNote = 10

var allowedNoteImageTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif":  true,
}

// decodeImageDimensions decodes data fully to confirm it is a valid,
// non-corrupt image (this is what enforces "images only" beyond the
// Content-Type sniff) and returns its pixel dimensions. Header-only bounds
// are checked first, mirroring the profile-icon pipeline, so a small file
// claiming huge dimensions is rejected before a full decode allocates memory
// for it (decompression-bomb protection).
func decodeImageDimensions(data []byte) (width, height int, err error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, fmt.Errorf("decode image config: %w", err)
	}
	if boundsErr := validateImageBounds(cfg); boundsErr != nil {
		return 0, 0, boundsErr
	}

	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return 0, 0, fmt.Errorf("decode image: %w", err)
	}

	return cfg.Width, cfg.Height, nil
}

// publishNoteImageEvent fetches the note's audience and publishes an SSE event.
// Errors are logged but never fail the HTTP request.
func (h *NotesHandler) publishNoteImageEvent(ctx context.Context, noteID string, eventType sse.EventType, data sse.NoteImageEventData, sourceUserID string) {
	if h.hub == nil {
		return
	}
	audienceIDs, err := h.noteStore.GetNoteAudienceIDs(ctx, noteID)
	if err != nil {
		logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).Error("Failed to get note audience for SSE publish")
		return
	}
	h.hub.Publish(ctx, audienceIDs, sse.Event{
		Type:         eventType,
		SourceUserID: sourceUserID,
		ClientID:     clientIDFromContext(ctx),
		Data:         data,
	})
}

// reclaimNoteImageBlob deletes the on-disk blob for sha if no note_images row
// still references it (dedup means another row may share the same content
// hash). Errors are logged but never fail the delete request — the row is
// already gone, and the periodic orphan sweep is the safety net for this path.
func (h *NotesHandler) reclaimNoteImageBlob(ctx context.Context, sha string) {
	count, err := h.noteStore.GetNoteImageRefCount(ctx, sha)
	if err != nil {
		logutil.FromContext(ctx).WithError(err).WithField("sha256", sha).Error("Failed to check note image refcount for blob reclamation")
		return
	}
	if count > 0 {
		return
	}
	if err := h.blobstore.Delete(ctx, sha); err != nil {
		logutil.FromContext(ctx).WithError(err).WithField("sha256", sha).Error("Failed to reclaim orphaned note image blob")
	}
}

// UploadNoteImage godoc
//
//	@Summary	Upload an image to a note
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		multipart/form-data
//	@Produce	json
//	@Param		id		path		string	true	"Note ID"
//	@Param		file	formData	file	true	"Image file (PNG, JPEG, WebP, or GIF)"
//	@Success	201		{object}	models.NoteImage
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	413		{string}	string	"file too large"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id}/images [post]
func (h *NotesHandler) UploadNoteImage(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	noteID := chi.URLParam(r, "id")
	if !models.IsValidID(noteID) {
		return http.StatusBadRequest, nil, errors.New("invalid note ID format")
	}

	hasAccess, err := h.noteStore.HasAccess(r.Context(), noteID, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("check note access: %w", err)
	}
	if !hasAccess {
		return http.StatusNotFound, nil, models.ErrNoteNotFound
	}

	// Fast-path pre-check: reject a note that's already at capacity before
	// doing any upload work (hashing, decoding, blob storage) for it. This is
	// only an optimization — CreateNoteImage enforces the cap atomically
	// inside a transaction, so concurrent uploads can't race past it even
	// though this check runs outside one.
	existing, err := h.noteStore.GetNoteImagesByNoteID(r.Context(), noteID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get note images: %w", err)
	}
	if len(existing) >= imageMaxPerNote {
		return http.StatusBadRequest, nil, fmt.Errorf("note cannot have more than %d images", imageMaxPerNote)
	}

	// Overhead for multipart boundary/header bytes on top of the file itself,
	// mirroring UploadProfileIcon.
	const multipartOverhead = int64(64 << 10)
	r.Body = http.MaxBytesReader(w, r.Body, h.uploadMaxBytes+multipartOverhead)
	if parseErr := r.ParseMultipartForm(h.uploadMaxBytes); parseErr != nil {
		// wrapHandler promotes a wrapped *http.MaxBytesError to 413 regardless
		// of the status returned here.
		return http.StatusBadRequest, nil, fmt.Errorf("parse multipart upload: %w", parseErr)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, nil, errors.New("file is required")
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("read uploaded file: %w", err)
	}

	contentType := http.DetectContentType(data)
	if !allowedNoteImageTypes[contentType] {
		return http.StatusBadRequest, nil, errors.New("unsupported file type: must be png, jpeg, webp, or gif")
	}

	width, height, err := decodeImageDimensions(data)
	if err != nil {
		return http.StatusBadRequest, nil, fmt.Errorf("unsupported or corrupt image: %w", err)
	}

	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])

	if putErr := h.blobstore.Put(r.Context(), sha, bytes.NewReader(data)); putErr != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("store image blob: %w", putErr)
	}

	img, err := h.noteStore.CreateNoteImage(r.Context(), noteID, user.ID, header.Filename, contentType, int64(len(data)), sha, width, height, imageMaxPerNote)
	if err != nil {
		if errors.Is(err, models.ErrNoteImageCapExceeded) {
			return http.StatusBadRequest, nil, fmt.Errorf("note cannot have more than %d images", imageMaxPerNote)
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("create note image: %w", err)
	}

	h.publishNoteImageEvent(r.Context(), noteID, sse.EventNoteImageAdded, sse.NoteImageEventData{NoteID: noteID, Image: img}, user.ID)

	return http.StatusCreated, img, nil
}

// GetNoteImage godoc
//
//	@Summary	Download a note image
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	image/*
//	@Param		id	path		string	true	"Image ID"
//	@Success	200	{file}		binary	"Image bytes"
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/images/{id} [get]
func (h *NotesHandler) GetNoteImage(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	imageID := chi.URLParam(r, "id")
	if !models.IsValidID(imageID) {
		return http.StatusBadRequest, nil, errors.New("invalid image ID format")
	}

	img, hasAccess, status, err := h.loadNoteImageForAccess(r.Context(), imageID, user.ID)
	if err != nil {
		return status, nil, err
	}
	if !hasAccess {
		return http.StatusNotFound, nil, models.ErrNoteImageNotFound
	}

	blob, err := h.blobstore.Open(r.Context(), img.SHA256)
	if err != nil {
		if errors.Is(err, blobstore.ErrNotFound) {
			logutil.FromContext(r.Context()).WithField("image_id", img.ID).WithField("sha256", img.SHA256).
				Error("Note image blob missing on disk")
			return http.StatusNotFound, nil, errors.New("image blob not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("open image blob: %w", err)
	}
	defer blob.Close()

	// No Content-Disposition: images are served inline for rendering (gallery,
	// lightbox), never as a forced download. Content-Type is set from the
	// validated type recorded at upload; nosniff stops the browser from
	// second-guessing it.
	w.Header().Set("Content-Type", img.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+img.SHA256+`"`)

	http.ServeContent(w, r, img.Filename, img.CreatedAt, blob)
	return 0, nil, nil
}

// loadNoteImageForAccess fetches an image row and checks that userID has
// access to its parent note, returning the appropriate HTTP status on
// failure. hasAccess is false (with no error) when the image exists but the
// user cannot see it; callers should treat that the same as not-found so
// existence isn't leaked to users without access.
func (h *NotesHandler) loadNoteImageForAccess(ctx context.Context, imageID, userID string) (img *models.NoteImage, hasAccess bool, status int, err error) {
	img, err = h.noteStore.GetNoteImageByID(ctx, imageID)
	if err != nil {
		if errors.Is(err, models.ErrNoteImageNotFound) {
			return nil, false, http.StatusNotFound, err
		}
		return nil, false, http.StatusInternalServerError, fmt.Errorf("get note image: %w", err)
	}

	hasAccess, err = h.noteStore.HasAccess(ctx, img.NoteID, userID)
	if err != nil {
		return nil, false, http.StatusInternalServerError, fmt.Errorf("check note access: %w", err)
	}
	return img, hasAccess, http.StatusOK, nil
}

// DeleteNoteImage godoc
//
//	@Summary	Delete a note image
//	@Tags		notes
//	@Security	CookieAuth
//	@Param		id	path		string	true	"Image ID"
//	@Success	204	"no content"
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/images/{id} [delete]
func (h *NotesHandler) DeleteNoteImage(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	imageID := chi.URLParam(r, "id")
	if !models.IsValidID(imageID) {
		return http.StatusBadRequest, nil, errors.New("invalid image ID format")
	}

	_, hasAccess, status, err := h.loadNoteImageForAccess(r.Context(), imageID, user.ID)
	if err != nil {
		return status, nil, err
	}
	if !hasAccess {
		return http.StatusNotFound, nil, models.ErrNoteImageNotFound
	}

	deleted, err := h.noteStore.DeleteNoteImage(r.Context(), imageID)
	if err != nil {
		if errors.Is(err, models.ErrNoteImageNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("delete note image: %w", err)
	}

	h.reclaimNoteImageBlob(r.Context(), deleted.SHA256)

	h.publishNoteImageEvent(r.Context(), deleted.NoteID, sse.EventNoteImageRemoved, sse.NoteImageEventData{NoteID: deleted.NoteID, ImageID: deleted.ID}, user.ID)

	return http.StatusNoContent, nil, nil
}
