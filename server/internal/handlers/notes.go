package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notesvc"
	"github.com/hanzei/jot/server/internal/notify"
	"github.com/hanzei/jot/server/internal/sse"
)

const queryTrue = "true"

// SearchQueryParam is the GET /notes query parameter that switches on the
// search LIKE-scan path (see GetNotes). Exported so callers outside this
// package (the server's rate-limit wiring) can key off the same name instead
// of duplicating the literal.
const SearchQueryParam = "search"

type NotesHandler struct {
	noteStore *models.NoteStore
	// notes performs the note writes shared with the MCP tools.
	notes          *notesvc.Service
	hub            *sse.Hub
	events         *notify.Publisher
	imageStore     *blobstore.ImageStore
	uploadMaxBytes int64
	// publicLinksEnabled is JOT_PUBLIC_LINKS_ENABLED.
	publicLinksEnabled bool
}

// NewNotesHandler creates a NotesHandler.
func NewNotesHandler(noteStore *models.NoteStore, notes *notesvc.Service, hub *sse.Hub, imageStore *blobstore.ImageStore, uploadMaxBytes int64, publicLinksEnabled bool) *NotesHandler {
	return &NotesHandler{
		noteStore:          noteStore,
		notes:              notes,
		hub:                hub,
		events:             notify.New(hub, noteStore),
		imageStore:         imageStore,
		uploadMaxBytes:     uploadMaxBytes,
		publicLinksEnabled: publicLinksEnabled,
	}
}

type CreateNoteRequest struct {
	// ID is an optional client-supplied note ID. When provided it is used as the
	// note's primary key so an offline-created note can be replayed idempotently:
	// a replay whose original create already committed is rejected with 409
	// instead of inserting a duplicate. When empty the server generates one.
	ID       string          `json:"id,omitempty"`
	Title    string          `json:"title"`
	Content  string          `json:"content"`
	NoteType models.NoteType `json:"note_type"`
	// Color is a hex color (#rgb or #rrggbb), stored and returned as lowercase
	// #rrggbb. Empty means the default (#ffffff).
	Color  string           `json:"color,omitempty"`
	Items  []CreateNoteItem `json:"items,omitempty"`
	Labels []string         `json:"labels,omitempty"`
	// Pinned creates the note already pinned for the creating user, so a client
	// that let the user pin a note before it existed needs no follow-up PATCH.
	Pinned bool `json:"pinned,omitempty"`
}

type CreateNoteItem struct {
	// ID is an optional client-supplied item ID. When provided it is honored so
	// the item keeps a stable identity for later per-item updates and offline
	// replay; when empty the server generates one.
	ID          string `json:"id"`
	Text        string `json:"text"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
	Completed   bool   `json:"completed"`
}

type UpdateNoteRequest struct {
	Title    *string `json:"title"`
	Content  *string `json:"content"`
	Pinned   *bool   `json:"pinned"`
	Archived *bool   `json:"archived"`
	// Color is a hex color (#rgb or #rrggbb), stored and returned as lowercase
	// #rrggbb. Empty resets to the default (#ffffff).
	Color                 *string `json:"color"`
	CheckedItemsCollapsed *bool   `json:"checked_items_collapsed"`
	// BaseVersion enables optimistic concurrency for shared title/content
	// changes: when those fields are changed and this is set, the update is
	// rejected with 409 unless the note's current version still matches it.
	// Per-user-only fields (color, pinned, archived, checked_items_collapsed)
	// ignore this value. When omitted, shared-content updates behave as
	// last-write-wins writes.
	BaseVersion *int `json:"base_version,omitempty"`
}

type EmptyTrashResponse struct {
	Deleted int `json:"deleted"`
}

// serviceItems converts request items to the notes service's form.
func serviceItems(items []CreateNoteItem) []notesvc.NewItem {
	out := make([]notesvc.NewItem, len(items))
	for i, item := range items {
		out[i] = notesvc.NewItem(item)
	}
	return out
}

// NoteListResponse is the GET /notes body.
type NoteListResponse struct {
	Notes []models.Note `json:"notes"`
}

// GetNotes godoc
//
//	@Summary	List notes for the current user
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Param		archived	query		boolean	false	"Return archived notes"
//	@Param		trashed		query		boolean	false	"Return trashed notes"
//	@Param		search		query		string	false	"Full-text search query"
//	@Param		label		query		string	false	"Filter by label ID"
//	@Param		my_tasks	query		boolean	false	"Return only notes with tasks assigned to current user"
//	@Success	200			{object}	NoteListResponse
//	@Failure	400			{object}	apierr.ErrorResponse	"search query too long"
//	@Failure	401			{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	500			{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes [get]
func (h *NotesHandler) GetNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	q := r.URL.Query()
	filter := models.NoteFilter{
		Archived: q.Get("archived") == queryTrue,
		Trashed:  q.Get("trashed") == queryTrue,
		MyTasks:  q.Get("my_tasks") == queryTrue,
		Search:   q.Get(SearchQueryParam),
		LabelID:  q.Get("label"),
	}

	if err := models.ValidateSearchQuery(filter.Search); err != nil {
		return http.StatusBadRequest, nil, err
	}

	notes, err := h.noteStore.GetByUserID(r.Context(), user.ID, filter)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get notes: %w", err)
	}

	return http.StatusOK, NoteListResponse{Notes: models.SanitizeNotes(notes)}, nil
}

// CreateNote godoc
//
//	@Summary	Create a new note
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		CreateNoteRequest	true	"Note to create"
//	@Success	201		{object}	models.Note
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"label not found"
//	@Failure	409		{object}	apierr.ErrorResponse	"note with this ID already exists"
//	@Failure	422		{object}	apierr.ErrorResponse	"note item cap exceeded (item_limit_reached) or label name too long (label_name_too_long)"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes [post]
func (h *NotesHandler) CreateNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	var req CreateNoteRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	note, err := h.notes.Create(r.Context(), user.ID, notesvc.NewNote{
		ID:      req.ID,
		Title:   req.Title,
		Content: req.Content,
		Type:    req.NoteType,
		Color:   req.Color,
		Items:   serviceItems(req.Items),
		Labels:  req.Labels,
		Pinned:  req.Pinned,
	})
	if err != nil {
		return storeError(err, "create note")
	}
	return http.StatusCreated, models.SanitizeNote(*note), nil
}

// GetNote godoc
//
//	@Summary	Get a single note by ID
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"Note ID"
//	@Success	200	{object}	models.Note
//	@Failure	400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404	{object}	apierr.ErrorResponse	"not found"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id} [get]
func (h *NotesHandler) GetNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	note, err := h.noteStore.GetByID(r.Context(), id, user.ID)
	if err != nil {
		return storeError(err, "get note")
	}

	return http.StatusOK, models.SanitizeNote(*note), nil
}

// DuplicateNoteRequest is the optional request body for the duplicate endpoint.
// When ID is supplied the caller's value is used as the new note's primary key
// so the operation is idempotent on replay (same ID → 409, no second copy).
// Omitting the body or leaving ID empty falls back to server-side ID generation.
// ItemIDs maps each source item ID to the caller-supplied new item ID, allowing
// offline clients to keep stable item IDs across sync so queued per-item edits
// still target valid IDs after the duplicate drains. Entries absent from the map
// fall back to server-side generation. Invalid values → 400; conflicts → 409.
type DuplicateNoteRequest struct {
	ID      string            `json:"id"`
	ItemIDs map[string]string `json:"item_ids"`
}

// DuplicateNote godoc
//
//	@Summary	Duplicate an existing note
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string					true	"Note ID"
//	@Param		body	body		DuplicateNoteRequest	false	"Optional client-supplied ID for idempotent replay"
//	@Success	201		{object}	models.Note
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"not found"
//	@Failure	409		{object}	apierr.ErrorResponse	"conflict — duplicate ID already exists"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/duplicate [post]
func (h *NotesHandler) DuplicateNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req DuplicateNoteRequest
	if r.ContentLength != 0 {
		if err := decodeJSONBody(w, r, &req); err != nil {
			return http.StatusBadRequest, nil, err
		}
	}
	note, err := h.notes.Duplicate(r.Context(), id, user.ID, req.ID, req.ItemIDs)
	if err != nil {
		return storeError(err, "duplicate note")
	}
	return http.StatusCreated, models.SanitizeNote(*note), nil
}

// ConvertNoteTypeRequest is the request body for POST /notes/{id}/convert.
// The transform (splitting text into list items, or rendering a list back
// into text) is computed client-side (see shared/src/noteConversion.ts) and
// sent precomputed; the server only validates it against the same size
// limits enforced on directly-authored note content and persists it
// atomically. Content is used when converting to 'text'; Title and Items when
// converting to 'list'.
type ConvertNoteTypeRequest struct {
	NoteType models.NoteType `json:"note_type"`
	Content  *string         `json:"content,omitempty"`
	// Title is the converted list's title, which the client promotes from a
	// leading heading in the text content. Omitting it leaves the note
	// untitled — the behavior every client had before the field existed.
	Title *string          `json:"title,omitempty"`
	Items []CreateNoteItem `json:"items,omitempty" validate:"max=500"`
	// BaseVersion enables optimistic concurrency, matching UpdateNoteRequest:
	// when set, the conversion is rejected with 409 unless the note's current
	// version still matches it.
	BaseVersion *int `json:"base_version,omitempty"`
}

// ConvertNoteType godoc
//
//	@Summary	Convert a note between text and list type
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string					true	"Note ID"
//	@Param		body	body		ConvertNoteTypeRequest	true	"Target note type and precomputed content/items"
//	@Success	200		{object}	models.Note
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"not found"
//	@Failure	409		{object}	apierr.ErrorResponse	"version conflict: note changed since base_version"
//	@Failure	422		{object}	apierr.ErrorResponse	"note item cap exceeded (item_limit_reached)"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/convert [post]
func (h *NotesHandler) ConvertNoteType(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req ConvertNoteTypeRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	note, err := h.notes.Convert(r.Context(), id, user.ID, notesvc.Conversion{
		Type:        req.NoteType,
		Content:     req.Content,
		Title:       req.Title,
		Items:       serviceItems(req.Items),
		BaseVersion: req.BaseVersion,
	})
	if err != nil {
		return storeError(err, "convert note")
	}
	return http.StatusOK, models.SanitizeNote(*note), nil
}

// UpdateNote godoc
//
//	@Summary	Update a note
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string				true	"Note ID"
//	@Param		body	body		UpdateNoteRequest	true	"Fields to update"
//	@Success	200		{object}	models.Note
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404		{object}	apierr.ErrorResponse	"not found"
//	@Failure	409		{object}	apierr.ErrorResponse	"version conflict for title/content update: note changed since base_version"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id} [patch]
func (h *NotesHandler) UpdateNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req UpdateNoteRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	note, err := h.notes.Update(r.Context(), id, user.ID, models.NoteUpdate{
		Title:                 req.Title,
		Content:               req.Content,
		Color:                 req.Color,
		Pinned:                req.Pinned,
		Archived:              req.Archived,
		CheckedItemsCollapsed: req.CheckedItemsCollapsed,
		BaseVersion:           req.BaseVersion,
	})
	if err != nil {
		return storeError(err, "update note")
	}
	return http.StatusOK, models.SanitizeNote(*note), nil
}

// DeleteNote godoc
//
//	@Summary	Delete a note (move to trash, or permanently delete)
//	@Tags		notes
//	@Security	CookieAuth
//	@Param		id			path	string	true	"Note ID"
//	@Param		permanent	query	boolean	false	"Permanently delete from trash instead of soft-deleting"
//	@Success	204			"no content"
//	@Failure	400			{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401			{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404			{object}	apierr.ErrorResponse	"not found"
//	@Failure	500			{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id} [delete]
func (h *NotesHandler) DeleteNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	permanent := r.URL.Query().Get("permanent") == queryTrue
	if err := h.notes.Delete(r.Context(), id, user.ID, permanent); err != nil {
		return storeError(err, "delete note")
	}
	return http.StatusNoContent, nil, nil
}

// EmptyTrash godoc
//
//	@Summary	Permanently delete all notes in the current user's trash
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	EmptyTrashResponse
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/trash [delete]
func (h *NotesHandler) EmptyTrash(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	deleted, err := h.notes.EmptyTrash(r.Context(), user.ID)
	if err != nil {
		return storeError(err, "empty trash")
	}
	return http.StatusOK, EmptyTrashResponse{Deleted: deleted}, nil
}

// MarkNoteViewedRequest is the optional body of POST /notes/{id}/viewed.
type MarkNoteViewedRequest struct {
	// ViewedAt is when the user opened the note. Omit it to mean now.
	ViewedAt *time.Time `json:"viewed_at,omitzero"`
}

// MarkNoteViewed godoc
//
//	@Summary		Mark a note as viewed
//	@Description	Records that the caller opened the note, clearing its "new"/"updated" unread badge for them. Idempotent. viewed_at is when the note was opened, for a client replaying a view it recorded offline; it defaults to now and is capped at now, and a change made after it stays unread. When the unread state changed, the caller's other sessions receive a note_updated event.
//	@Tags			notes
//	@Security		CookieAuth
//	@Param			id		path	string					true	"Note ID"
//	@Param			request	body	MarkNoteViewedRequest	false	"When the note was viewed"
//	@Success		204
//	@Failure		400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		404	{object}	apierr.ErrorResponse	"not found"
//	@Failure		500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/{id}/viewed [post]
func (h *NotesHandler) MarkNoteViewed(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	var req MarkNoteViewedRequest
	if r.ContentLength != 0 {
		if err := decodeJSONBody(w, r, &req); err != nil {
			return http.StatusBadRequest, nil, err
		}
	}
	viewedAt := models.Now()
	if req.ViewedAt != nil && req.ViewedAt.Before(viewedAt) {
		viewedAt = req.ViewedAt.UTC()
	}

	changed, err := h.noteStore.MarkViewed(r.Context(), id, user.ID, viewedAt)
	if err != nil {
		return storeError(err, "mark note viewed")
	}

	// Unread state is per-user, so only the caller's own sessions need to hear
	// of it, and only when it actually changed.
	if changed {
		h.events.PersonalizedNote(r.Context(), id, []string{user.ID}, user.ID, sse.EventNoteUpdated)
	}

	return http.StatusNoContent, nil, nil
}

// RestoreNote godoc
//
//	@Summary	Restore a note from trash
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"Note ID"
//	@Success	200	{object}	models.Note
//	@Failure	400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	404	{object}	apierr.ErrorResponse	"not found"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/{id}/restore [post]
func (h *NotesHandler) RestoreNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	id, idErr := pathID(r, "id", "note")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
	}

	note, err := h.notes.Restore(r.Context(), id, user.ID)
	if err != nil {
		return storeError(err, "restore note")
	}
	return http.StatusOK, models.SanitizeNote(*note), nil
}

type ReorderNotesRequest struct {
	NoteIDs []string `json:"note_ids"`
}

// ReorderNotes godoc
//
//	@Summary	Reorder notes by providing an ordered list of IDs
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		json
//	@Param		body	body	ReorderNotesRequest	true	"Ordered note IDs"
//	@Success	204		"no content"
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403		{object}	apierr.ErrorResponse	"forbidden"
//	@Failure	500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/reorder [post]
func (h *NotesHandler) ReorderNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	var req ReorderNotesRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if len(req.NoteIDs) == 0 {
		return http.StatusBadRequest, nil, errors.New("empty note IDs list")
	}

	err := h.noteStore.ReorderNotes(r.Context(), user.ID, req.NoteIDs)
	if err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, err
		}
		return storeError(err, "reorder notes")
	}

	return http.StatusNoContent, nil, nil
}
