package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/sirupsen/logrus"
)

const queryTrue = "true"

type NotesHandler struct {
	noteStore  *models.NoteStore
	userStore  *models.UserStore
	labelStore *models.LabelStore
	hub        *sse.Hub
}

func NewNotesHandler(noteStore *models.NoteStore, userStore *models.UserStore, labelStore *models.LabelStore, hub *sse.Hub) *NotesHandler {
	return &NotesHandler{
		noteStore:  noteStore,
		userStore:  userStore,
		labelStore: labelStore,
		hub:        hub,
	}
}

// publishNoteEvent fetches the note's audience and publishes an SSE event.
// Errors are logged but never fail the HTTP request.
func (h *NotesHandler) publishNoteEvent(noteID string, eventType sse.EventType, note any, sourceUserID string) {
	if h.hub == nil {
		return
	}
	audienceIDs, err := h.noteStore.GetNoteAudienceIDs(noteID)
	if err != nil {
		logrus.WithError(err).WithField("note_id", noteID).Error("failed to get note audience for SSE publish")
		return
	}
	h.hub.Publish(audienceIDs, sse.Event{
		Type:         eventType,
		NoteID:       noteID,
		Note:         note,
		SourceUserID: sourceUserID,
	})
}

type CreateNoteRequest struct {
	Title    string           `json:"title"`
	Content  string           `json:"content"`
	NoteType models.NoteType  `json:"note_type"`
	Color    string           `json:"color,omitempty"`
	Items    []CreateNoteItem `json:"items,omitempty"`
	Labels   []string         `json:"labels,omitempty"`
}

type CreateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

type UpdateNoteRequest struct {
	Title                 *string          `json:"title"`
	Content               *string          `json:"content"`
	Pinned                *bool            `json:"pinned"`
	Archived              *bool            `json:"archived"`
	Color                 *string          `json:"color"`
	CheckedItemsCollapsed *bool            `json:"checked_items_collapsed"`
	Items                 []UpdateNoteItem `json:"items,omitempty"`
}

type UpdateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	Completed   bool   `json:"completed"`
	IndentLevel int    `json:"indent_level"`
	AssignedTo  string `json:"assigned_to"`
}

func normalizeCreateNoteRequest(req *CreateNoteRequest) (int, error) {
	if req.Title == "" && req.Content == "" && len(req.Items) == 0 {
		return http.StatusBadRequest, errors.New("note must have a title, content, or items")
	}

	if len(req.Items) > 0 {
		if req.NoteType == "" {
			req.NoteType = models.NoteTypeTodo
		} else if req.NoteType != models.NoteTypeTodo {
			return http.StatusBadRequest, errors.New("note_type must be 'todo' when items are provided")
		}
	} else if req.NoteType == "" {
		req.NoteType = models.NoteTypeText
	}

	if req.Color == "" {
		req.Color = models.DefaultNoteColor
	}

	return http.StatusOK, nil
}

func (h *NotesHandler) createNoteLabels(noteID, userID string, rawLabels []string) (int, error) {
	seen := make(map[string]struct{})
	for _, raw := range rawLabels {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}

		label, err := h.labelStore.GetOrCreateLabel(userID, name)
		if err != nil {
			return http.StatusInternalServerError, fmt.Errorf("get or create label: %w", err)
		}
		if err = h.noteStore.AddLabelToNote(noteID, label.ID, userID); err != nil {
			return http.StatusInternalServerError, fmt.Errorf("add label to note: %w", err)
		}
	}
	return http.StatusOK, nil
}

func (h *NotesHandler) createTodoItems(noteID string, items []CreateNoteItem) (int, error) {
	for _, item := range items {
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return http.StatusBadRequest, errors.New("indent_level must be 0 or 1")
		}
		if _, err := h.noteStore.CreateItem(noteID, item.Text, item.Position, item.IndentLevel, ""); err != nil {
			return http.StatusInternalServerError, err
		}
	}
	return http.StatusOK, nil
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
//	@Param		my_todo		query		boolean	false	"Return only notes with todos assigned to current user"
//	@Success	200			{array}		models.Note
//	@Failure	401			{string}	string	"unauthorized"
//	@Failure	500			{string}	string	"internal server error"
//	@Router		/notes [get]
func (h *NotesHandler) GetNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	q := r.URL.Query()
	trashed := q.Get("trashed") == queryTrue
	archived := q.Get("archived") == queryTrue
	search := q.Get("search")
	labelID := q.Get("label")
	myTodo := q.Get("my_todo") == queryTrue

	notes, err := h.noteStore.GetByUserID(user.ID, archived, trashed, search, labelID, myTodo)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusOK, notes, nil
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
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes [post]
func (h *NotesHandler) CreateNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	var req CreateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if status, err := normalizeCreateNoteRequest(&req); err != nil {
		return status, nil, err
	}

	note, err := h.noteStore.Create(user.ID, req.Title, req.Content, req.NoteType, req.Color)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	needRefetch := false

	if req.NoteType == models.NoteTypeTodo && len(req.Items) > 0 {
		if status, err := h.createTodoItems(note.ID, req.Items); err != nil {
			return status, nil, err
		}
		needRefetch = true
	}

	if len(req.Labels) > 0 {
		if status, err := h.createNoteLabels(note.ID, user.ID, req.Labels); err != nil {
			return status, nil, err
		}
		needRefetch = true
	}

	if needRefetch {
		updatedNote, refetchErr := h.noteStore.GetByID(note.ID, user.ID)
		if refetchErr != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("refetch updated note: %w", refetchErr)
		}
		note = updatedNote
	}

	h.publishNoteEvent(note.ID, sse.EventNoteCreated, note, user.ID)
	return http.StatusCreated, note, nil
}

// GetNote godoc
//
//	@Summary	Get a single note by ID
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"Note ID"
//	@Success	200	{object}	models.Note
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id} [get]
func (h *NotesHandler) GetNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
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

	note, err := h.noteStore.GetByID(id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusOK, note, nil
}

func (h *NotesHandler) validateTodoItems(noteID string, items []UpdateNoteItem) (int, error) {
	for _, item := range items {
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return http.StatusBadRequest, errors.New("indent_level must be 0 or 1")
		}
	}

	if status, err := h.validateItemAssignments(noteID, items); err != nil {
		return status, err
	}

	return http.StatusOK, nil
}

// validateItemAssignments checks that all assigned user IDs are valid and have access to the note.
func (h *NotesHandler) validateItemAssignments(noteID string, items []UpdateNoteItem) (int, error) {
	hasAssignment := false
	for _, item := range items {
		if item.AssignedTo != "" {
			hasAssignment = true
			break
		}
	}
	if !hasAssignment {
		return http.StatusOK, nil
	}

	shares, err := h.noteStore.GetNoteShares(noteID)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("failed to check note shares: %w", err)
	}
	if len(shares) == 0 {
		return http.StatusBadRequest, errors.New("cannot assign items on an unshared note")
	}

	ownerID, err := h.noteStore.GetOwnerID(noteID)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("failed to get note owner: %w", err)
	}

	accessSet := make(map[string]struct{})
	accessSet[ownerID] = struct{}{}
	for _, share := range shares {
		accessSet[share.SharedWithUserID] = struct{}{}
	}

	for _, item := range items {
		if item.AssignedTo == "" {
			continue
		}
		if !models.IsValidID(item.AssignedTo) {
			return http.StatusBadRequest, errors.New("invalid assigned_to format")
		}
		if _, ok := accessSet[item.AssignedTo]; !ok {
			return http.StatusBadRequest, errors.New("assigned user does not have access to this note")
		}
	}

	return http.StatusOK, nil
}

func (h *NotesHandler) updateTodoItems(noteID string, userID string, items []UpdateNoteItem) error {
	currentNote, err := h.noteStore.GetByID(noteID, userID)
	if err != nil {
		return err
	}

	if currentNote.NoteType == models.NoteTypeTodo {
		if err := h.noteStore.DeleteItemsByNoteID(noteID); err != nil {
			return err
		}

		for _, item := range items {
			_, err := h.noteStore.CreateItemWithCompleted(noteID, item.Text, item.Position, item.Completed, item.IndentLevel, item.AssignedTo)
			if err != nil {
				return err
			}
		}
	}
	return nil
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
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	404		{string}	string	"not found"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/{id} [patch]
func (h *NotesHandler) UpdateNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
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

	var req UpdateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	// Validate items before persisting any changes so invalid assigned_to
	// values are rejected before note metadata is committed.
	if len(req.Items) > 0 {
		if status, err := h.validateTodoItems(id, req.Items); err != nil {
			return status, nil, err
		}
	}

	err := h.noteStore.Update(id, user.ID, req.Title, req.Content, req.Color, req.Pinned, req.Archived, req.CheckedItemsCollapsed)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) || errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	if len(req.Items) > 0 {
		if updateErr := h.updateTodoItems(id, user.ID, req.Items); updateErr != nil {
			return http.StatusInternalServerError, nil, updateErr
		}
	}

	note, err := h.noteStore.GetByID(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	h.publishNoteEvent(id, sse.EventNoteUpdated, note, user.ID)
	return http.StatusOK, note, nil
}

// DeleteNote godoc
//
//	@Summary	Delete a note (move to trash, or permanently delete)
//	@Tags		notes
//	@Security	CookieAuth
//	@Param		id			path		string	true	"Note ID"
//	@Param		permanent	query		boolean	false	"Permanently delete from trash instead of soft-deleting"
//	@Success	204			"no content"
//	@Failure	400			{string}	string	"bad request"
//	@Failure	401			{string}	string	"unauthorized"
//	@Failure	404			{string}	string	"not found"
//	@Failure	500			{string}	string	"internal server error"
//	@Router		/notes/{id} [delete]
func (h *NotesHandler) DeleteNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
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

	permanent := r.URL.Query().Get("permanent") == queryTrue

	// Fetch audience before deleting so we can notify share targets too.
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(id)

	if permanent {
		err := h.noteStore.DeleteFromTrash(id, user.ID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotInTrash) {
				return http.StatusNotFound, nil, err
			}
			return http.StatusInternalServerError, nil, err
		}
	} else {
		err := h.noteStore.MoveToTrash(id, user.ID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotOwnedByUser) {
				return http.StatusNotFound, nil, err
			}
			return http.StatusInternalServerError, nil, err
		}
	}

	if audienceErr == nil && h.hub != nil {
		h.hub.Publish(audienceIDs, sse.Event{
			Type:         sse.EventNoteDeleted,
			NoteID:       id,
			Note:         nil,
			SourceUserID: user.ID,
		})
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
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/restore [post]
func (h *NotesHandler) RestoreNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
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

	err := h.noteStore.RestoreFromTrash(id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotOwnedByUser) || errors.Is(err, models.ErrNoteNotInTrash) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	note, err := h.noteStore.GetByID(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	h.publishNoteEvent(id, sse.EventNoteUpdated, note, user.ID)
	return http.StatusOK, note, nil
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
//	@Param		body	body		ReorderNotesRequest	true	"Ordered note IDs"
//	@Success	204		"no content"
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"forbidden"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/notes/reorder [post]
func (h *NotesHandler) ReorderNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	var req ReorderNotesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if len(req.NoteIDs) == 0 {
		return http.StatusBadRequest, nil, errors.New("empty note IDs list")
	}

	err := h.noteStore.ReorderNotes(user.ID, req.NoteIDs)
	if err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusNoContent, nil, nil
}
