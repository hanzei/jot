package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
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
func (h *NotesHandler) publishNoteEvent(ctx context.Context, noteID string, eventType sse.EventType, note any, sourceUserID string) {
	if h.hub == nil {
		return
	}
	audienceIDs, err := h.noteStore.GetNoteAudienceIDs(ctx, noteID)
	if err != nil {
		logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).Error("failed to get note audience for SSE publish")
		return
	}
	h.hub.Publish(audienceIDs, sse.Event{
		Type:         eventType,
		NoteID:       noteID,
		Note:         note,
		SourceUserID: sourceUserID,
	})
}

// publishPersonalizedNoteEvent fetches each audience member's personalized view of a note
// and sends them an individual SSE event. Used when shared fields (title, content, items)
// change so every collaborator receives the update with their own per-user state intact.
// Errors are logged but never fail the HTTP request.
func (h *NotesHandler) publishPersonalizedNoteEvent(ctx context.Context, noteID string, audienceIDs []string, sourceUserID string) {
	if h.hub == nil {
		return
	}
	for _, uid := range audienceIDs {
		n, err := h.noteStore.GetByID(ctx, noteID, uid)
		if err != nil {
			logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).WithField("user_id", uid).Warn("failed to fetch personalized note for SSE publish")
			continue
		}
		h.hub.Publish([]string{uid}, sse.Event{
			Type:         sse.EventNoteUpdated,
			NoteID:       noteID,
			Note:         n,
			SourceUserID: sourceUserID,
		})
	}
}

func (h *NotesHandler) publishDeletedNoteEvent(noteID string, audienceIDs []string, sourceUserID string) {
	if h.hub == nil || len(audienceIDs) == 0 {
		return
	}

	h.hub.Publish(audienceIDs, sse.Event{
		Type:         sse.EventNoteDeleted,
		NoteID:       noteID,
		Note:         nil,
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
	Completed   bool   `json:"completed"`
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

type EmptyTrashResponse struct {
	Deleted int `json:"deleted"`
}

func normalizeCreateNoteRequest(req *CreateNoteRequest) (int, error) {
	if req.Title == "" && req.Content == "" && len(req.Items) == 0 {
		return http.StatusBadRequest, errors.New("note must have a title, content, or items")
	}

	if utf8.RuneCountInString(req.Title) > noteTitleMaxLength {
		return http.StatusBadRequest, fmt.Errorf("title must be %d characters or fewer", noteTitleMaxLength)
	}
	if utf8.RuneCountInString(req.Content) > noteContentMaxLength {
		return http.StatusBadRequest, fmt.Errorf("content must be %d characters or fewer", noteContentMaxLength)
	}
	if len(req.Items) > noteItemsMaxCount {
		return http.StatusBadRequest, fmt.Errorf("note cannot have more than %d items", noteItemsMaxCount)
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

	if err := validateColor(req.Color); err != nil {
		return http.StatusBadRequest, err
	}

	return http.StatusOK, nil
}

func (h *NotesHandler) createNoteLabels(ctx context.Context, noteID, userID string, rawLabels []string) (int, error) {
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

		label, err := h.labelStore.GetOrCreateLabel(ctx, userID, name)
		if err != nil {
			return http.StatusInternalServerError, fmt.Errorf("get or create label: %w", err)
		}
		if err = h.noteStore.AddLabelToNote(ctx, noteID, label.ID, userID); err != nil {
			if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
				return http.StatusNotFound, fmt.Errorf("label not found: %w", err)
			}
			return http.StatusInternalServerError, fmt.Errorf("add label to note: %w", err)
		}
	}
	return http.StatusOK, nil
}

func (h *NotesHandler) createTodoItems(ctx context.Context, noteID string, items []CreateNoteItem) (int, error) {
	for _, item := range items {
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return http.StatusBadRequest, errors.New("indent_level must be 0 or 1")
		}
		if utf8.RuneCountInString(item.Text) > noteItemTextMaxLength {
			return http.StatusBadRequest, fmt.Errorf("item text must be %d characters or fewer", noteItemTextMaxLength)
		}
		if _, err := h.noteStore.CreateItemWithCompleted(ctx, noteID, item.Text, item.Position, item.Completed, item.IndentLevel, ""); err != nil {
			return http.StatusInternalServerError, fmt.Errorf("create todo item: %w", err)
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

	notes, err := h.noteStore.GetByUserID(r.Context(), user.ID, archived, trashed, search, labelID, myTodo)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get notes: %w", err)
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
//	@Failure	404		{string}	string	"label not found"
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

	note, err := h.noteStore.Create(r.Context(), user.ID, req.Title, req.Content, req.NoteType, req.Color)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("create note: %w", err)
	}

	needRefetch := false

	if req.NoteType == models.NoteTypeTodo && len(req.Items) > 0 {
		if status, err := h.createTodoItems(r.Context(), note.ID, req.Items); err != nil {
			return status, nil, err
		}
		needRefetch = true
	}

	if len(req.Labels) > 0 {
		if status, err := h.createNoteLabels(r.Context(), note.ID, user.ID, req.Labels); err != nil {
			return status, nil, err
		}
		needRefetch = true
	}

	if needRefetch {
		updatedNote, refetchErr := h.noteStore.GetByID(r.Context(), note.ID, user.ID)
		if refetchErr != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("refetch updated note: %w", refetchErr)
		}
		note = updatedNote
	}

	h.publishNoteEvent(r.Context(), note.ID, sse.EventNoteCreated, note, user.ID)
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

	note, err := h.noteStore.GetByID(r.Context(), id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("get note: %w", err)
	}

	return http.StatusOK, note, nil
}

// DuplicateNote godoc
//
//	@Summary	Duplicate an existing note
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"Note ID"
//	@Success	201	{object}	models.Note
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/{id}/duplicate [post]
func (h *NotesHandler) DuplicateNote(w http.ResponseWriter, r *http.Request) (int, any, error) {
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

	sourceNote, err := h.noteStore.GetByID(r.Context(), id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("get note: %w", err)
	}

	duplicatedNote, err := h.noteStore.Duplicate(r.Context(), sourceNote, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("duplicate note: %w", err)
	}

	h.publishNoteEvent(r.Context(), duplicatedNote.ID, sse.EventNoteCreated, duplicatedNote, user.ID)
	return http.StatusCreated, duplicatedNote, nil
}

func normalizeUpdateNoteRequest(req *UpdateNoteRequest) (int, error) {
	if req.Title != nil && utf8.RuneCountInString(*req.Title) > noteTitleMaxLength {
		return http.StatusBadRequest, fmt.Errorf("title must be %d characters or fewer", noteTitleMaxLength)
	}
	if req.Content != nil && utf8.RuneCountInString(*req.Content) > noteContentMaxLength {
		return http.StatusBadRequest, fmt.Errorf("content must be %d characters or fewer", noteContentMaxLength)
	}
	if req.Color != nil {
		if *req.Color == "" {
			*req.Color = models.DefaultNoteColor
		}
		if err := validateColor(*req.Color); err != nil {
			return http.StatusBadRequest, err
		}
	}
	return http.StatusOK, nil
}

func (h *NotesHandler) validateTodoItems(ctx context.Context, noteID string, items []UpdateNoteItem) (int, error) {
	if len(items) > noteItemsMaxCount {
		return http.StatusBadRequest, fmt.Errorf("note cannot have more than %d items", noteItemsMaxCount)
	}

	for _, item := range items {
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return http.StatusBadRequest, errors.New("indent_level must be 0 or 1")
		}
		if utf8.RuneCountInString(item.Text) > noteItemTextMaxLength {
			return http.StatusBadRequest, fmt.Errorf("item text must be %d characters or fewer", noteItemTextMaxLength)
		}
	}

	if status, err := h.validateItemAssignments(ctx, noteID, items); err != nil {
		return status, err
	}

	return http.StatusOK, nil
}

// validateItemAssignments checks that all assigned user IDs are valid and have access to the note.
func (h *NotesHandler) validateItemAssignments(ctx context.Context, noteID string, items []UpdateNoteItem) (int, error) {
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

	shares, err := h.noteStore.GetNoteShares(ctx, noteID)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("failed to check note shares: %w", err)
	}
	if len(shares) == 0 {
		return http.StatusBadRequest, errors.New("cannot assign items on an unshared note")
	}

	ownerID, err := h.noteStore.GetOwnerID(ctx, noteID)
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

func (h *NotesHandler) updateTodoItems(ctx context.Context, noteID string, userID string, items []UpdateNoteItem) error {
	currentNote, err := h.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return fmt.Errorf("get note: %w", err)
	}

	if currentNote.NoteType == models.NoteTypeTodo {
		if err := h.noteStore.DeleteItemsByNoteID(ctx, noteID); err != nil {
			return fmt.Errorf("delete note items: %w", err)
		}

		for _, item := range items {
			_, err := h.noteStore.CreateItemWithCompleted(ctx, noteID, item.Text, item.Position, item.Completed, item.IndentLevel, item.AssignedTo)
			if err != nil {
				return fmt.Errorf("create note item: %w", err)
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

	if status, err := normalizeUpdateNoteRequest(&req); err != nil {
		return status, nil, err
	}

	// Validate items before persisting any changes so invalid assigned_to
	// values are rejected before note metadata is committed.
	// req.Items can be either:
	// - nil: "items" omitted from payload (do not touch existing items)
	// - empty/non-empty slice: "items" explicitly provided (replace items)
	if req.Items != nil {
		if status, err := h.validateTodoItems(r.Context(), id, req.Items); err != nil {
			return status, nil, err
		}
	}

	err := h.noteStore.Update(r.Context(), id, user.ID, req.Title, req.Content, req.Color, req.Pinned, req.Archived, req.CheckedItemsCollapsed)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) || errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("update note: %w", err)
	}

	if req.Items != nil {
		if updateErr := h.updateTodoItems(r.Context(), id, user.ID, req.Items); updateErr != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("update todo items: %w", updateErr)
		}
	}

	note, err := h.noteStore.GetByID(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get note: %w", err)
	}

	// Title, content, and items are shared fields: every collaborator must receive
	// their own personalized copy of the note (preserving their per-user state).
	// Per-user-only changes (color, pinned, archived, checked_items_collapsed) only
	// need to be delivered to the acting user.
	hasSharedFieldChange := req.Title != nil || req.Content != nil || req.Items != nil
	h.publishUpdateEvent(r.Context(), id, note, user.ID, hasSharedFieldChange)

	return http.StatusOK, note, nil
}

// publishUpdateEvent sends SSE notifications after a note update. If shared fields
// changed, every collaborator gets a personalized event; otherwise only the acting
// user is notified.
func (h *NotesHandler) publishUpdateEvent(ctx context.Context, noteID string, note *models.Note, userID string, sharedFieldChanged bool) {
	if sharedFieldChanged {
		audienceIDs, err := h.noteStore.GetNoteAudienceIDs(ctx, noteID)
		if err != nil {
			logutil.FromContext(ctx).WithError(err).WithField("note_id", noteID).Error("failed to get note audience for SSE publish")
			return
		}
		h.publishPersonalizedNoteEvent(ctx, noteID, audienceIDs, userID)
		return
	}
	if h.hub != nil {
		h.hub.Publish([]string{userID}, sse.Event{
			Type:         sse.EventNoteUpdated,
			NoteID:       noteID,
			Note:         note,
			SourceUserID: userID,
		})
	}
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
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(r.Context(), id)

	if permanent {
		err := h.noteStore.DeleteFromTrash(r.Context(), id, user.ID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotInTrash) {
				return http.StatusNotFound, nil, err
			}
			return http.StatusInternalServerError, nil, fmt.Errorf("delete note from trash: %w", err)
		}
	} else {
		err := h.noteStore.MoveToTrash(r.Context(), id, user.ID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotOwnedByUser) {
				return http.StatusNotFound, nil, err
			}
			return http.StatusInternalServerError, nil, fmt.Errorf("move note to trash: %w", err)
		}
	}

	if audienceErr == nil {
		h.publishDeletedNoteEvent(id, audienceIDs, user.ID)
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
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/trash [delete]
func (h *NotesHandler) EmptyTrash(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	deletedNotes, err := h.noteStore.EmptyTrash(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("empty trash: %w", err)
	}

	for _, deletedNote := range deletedNotes {
		h.publishDeletedNoteEvent(deletedNote.NoteID, deletedNote.AudienceIDs, user.ID)
	}

	return http.StatusOK, EmptyTrashResponse{Deleted: len(deletedNotes)}, nil
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

	err := h.noteStore.RestoreFromTrash(r.Context(), id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotOwnedByUser) || errors.Is(err, models.ErrNoteNotInTrash) {
			return http.StatusNotFound, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("restore note: %w", err)
	}

	note, err := h.noteStore.GetByID(r.Context(), id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("get note: %w", err)
	}

	h.publishNoteEvent(r.Context(), id, sse.EventNoteUpdated, note, user.ID)
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

	err := h.noteStore.ReorderNotes(r.Context(), user.ID, req.NoteIDs)
	if err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, nil, err
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("reorder notes: %w", err)
	}

	return http.StatusNoContent, nil, nil
}
