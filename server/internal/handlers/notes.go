package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/sirupsen/logrus"
)

// UserInfo contains safe public fields returned when listing users for share-target search.
type UserInfo struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	FirstName      string `json:"first_name"`
	LastName       string `json:"last_name"`
	Role           string `json:"role"`
	HasProfileIcon bool   `json:"has_profile_icon"`
}

type NotesHandler struct {
	noteStore *models.NoteStore
	userStore *models.UserStore
	hub       *sse.Hub
}

func NewNotesHandler(noteStore *models.NoteStore, userStore *models.UserStore, hub *sse.Hub) *NotesHandler {
	return &NotesHandler{
		noteStore: noteStore,
		userStore: userStore,
		hub:       hub,
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
}

type CreateNoteItem struct {
	Text        string `json:"text"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

type UpdateNoteRequest struct {
	Title                 string           `json:"title"`
	Content               string           `json:"content"`
	Pinned                bool             `json:"pinned"`
	Archived              bool             `json:"archived"`
	Color                 string           `json:"color"`
	CheckedItemsCollapsed bool             `json:"checked_items_collapsed"`
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
		return http.StatusBadRequest, errors.New("empty note")
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

	return 0, nil
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
	return 0, nil
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
//	@Success	200			{array}		models.Note
//	@Failure	401			{string}	string	"unauthorized"
//	@Router		/notes [get]
func (h *NotesHandler) GetNotes(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	trashed := r.URL.Query().Get("trashed") == "true"
	archived := r.URL.Query().Get("archived") == "true"
	search := r.URL.Query().Get("search")
	labelID := r.URL.Query().Get("label")

	notes, err := h.noteStore.GetByUserID(user.ID, archived, trashed, search, labelID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(notes); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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
//	@Router		/notes [post]
func (h *NotesHandler) CreateNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req CreateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if status, err := normalizeCreateNoteRequest(&req); err != nil {
		return status, err
	}

	note, err := h.noteStore.Create(user.ID, req.Title, req.Content, req.NoteType, req.Color)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if req.NoteType == models.NoteTypeTodo && len(req.Items) > 0 {
		if status, err := h.createTodoItems(note.ID, req.Items); err != nil {
			return status, err
		}

		updatedNote, err := h.noteStore.GetByID(note.ID, user.ID)
		if err != nil {
			return http.StatusInternalServerError, err
		}
		note = updatedNote
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	h.publishNoteEvent(note.ID, sse.EventNoteCreated, note, user.ID)
	return 0, nil
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
//	@Router		/notes/{id} [get]
func (h *NotesHandler) GetNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	note, err := h.noteStore.GetByID(id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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

	return 0, nil
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
		return 0, nil
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

	return 0, nil
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
//	@Router		/notes/{id} [put]
func (h *NotesHandler) UpdateNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	var req UpdateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Color == "" {
		req.Color = models.DefaultNoteColor
	}

	// Validate items before persisting any changes so invalid assigned_to
	// values are rejected before note metadata is committed.
	if len(req.Items) > 0 {
		if status, err := h.validateTodoItems(id, req.Items); err != nil {
			return status, err
		}
	}

	err := h.noteStore.Update(id, user.ID, req.Title, req.Content, req.Pinned, req.Archived, req.Color, req.CheckedItemsCollapsed)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) || errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	if len(req.Items) > 0 {
		if updateErr := h.updateTodoItems(id, user.ID, req.Items); updateErr != nil {
			return http.StatusInternalServerError, updateErr
		}
	}

	note, err := h.noteStore.GetByID(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	h.publishNoteEvent(id, sse.EventNoteUpdated, note, user.ID)
	return 0, nil
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
//	@Router		/notes/{id} [delete]
func (h *NotesHandler) DeleteNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	permanent := r.URL.Query().Get("permanent") == "true"

	// Fetch audience before deleting so we can notify share targets too.
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(id)

	if permanent {
		err := h.noteStore.DeleteFromTrash(id, user.ID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotInTrash) {
				return http.StatusNotFound, err
			}
			return http.StatusInternalServerError, err
		}
	} else {
		err := h.noteStore.MoveToTrash(id, user.ID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotOwnedByUser) {
				return http.StatusNotFound, err
			}
			return http.StatusInternalServerError, err
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

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
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
//	@Router		/notes/{id}/restore [post]
func (h *NotesHandler) RestoreNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	err := h.noteStore.RestoreFromTrash(id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotOwnedByUser) || errors.Is(err, models.ErrNoteNotInTrash) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	note, err := h.noteStore.GetByID(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	h.publishNoteEvent(id, sse.EventNoteUpdated, note, user.ID)
	return 0, nil
}

type ShareNoteRequest struct {
	Username string `json:"username"`
}

type ShareNoteResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// ShareNote godoc
//
//	@Summary	Share a note with another user
//	@Tags		sharing
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string				true	"Note ID"
//	@Param		body	body		ShareNoteRequest	true	"Username to share with"
//	@Success	200		{object}	ShareNoteResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"not owner"
//	@Failure	404		{string}	string	"not found"
//	@Failure	409		{string}	string	"already shared"
//	@Router		/notes/{id}/share [post]
func (h *NotesHandler) ShareNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	var req ShareNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Username == "" {
		return http.StatusBadRequest, errors.New("empty username")
	}

	isOwner, err := h.noteStore.IsOwner(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !isOwner {
		return http.StatusForbidden, errors.New("not owner")
	}

	targetUser, err := h.userStore.GetByUsername(req.Username)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	if targetUser.ID == user.ID {
		return http.StatusBadRequest, errors.New("cannot share with self")
	}

	err = h.noteStore.ShareNote(id, user.ID, targetUser.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteAlreadyShared) {
			return http.StatusConflict, err
		}
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(ShareNoteResponse{
		Success: true,
		Message: "Note shared successfully",
	}); err != nil {
		return http.StatusInternalServerError, err
	}

	// Fetch the note to include in the SSE payload; audience now includes the new target.
	if sharedNote, err := h.noteStore.GetByID(id, user.ID); err == nil {
		h.publishNoteEvent(id, sse.EventNoteShared, sharedNote, user.ID)
	}

	return 0, nil
}

// UnshareNote godoc
//
//	@Summary	Remove a share from a note
//	@Tags		sharing
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string				true	"Note ID"
//	@Param		body	body		ShareNoteRequest	true	"Username to unshare with"
//	@Success	200		{object}	ShareNoteResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"not owner"
//	@Failure	404		{string}	string	"not found"
//	@Router		/notes/{id}/share [delete]
func (h *NotesHandler) UnshareNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	var req ShareNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Username == "" {
		return http.StatusBadRequest, errors.New("empty username")
	}

	isOwner, err := h.noteStore.IsOwner(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !isOwner {
		return http.StatusForbidden, errors.New("not owner")
	}

	targetUser, err := h.userStore.GetByUsername(req.Username)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	// Fetch audience before unsharing so the target user is still in the list.
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(id)

	err = h.noteStore.UnshareNote(id, targetUser.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteShareNotFound) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	if audienceErr == nil && h.hub != nil {
		h.hub.Publish(audienceIDs, sse.Event{
			Type:         sse.EventNoteUnshared,
			NoteID:       id,
			Note:         nil,
			SourceUserID: user.ID,
			TargetUserID: targetUser.ID,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(ShareNoteResponse{
		Success: true,
		Message: "Note unshared successfully",
	}); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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
//	@Router		/notes/{id}/shares [get]
func (h *NotesHandler) GetNoteShares(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	id := chi.URLParam(r, "id")
	if id == "" {
		return http.StatusBadRequest, errors.New("missing note ID")
	}
	if !models.IsValidID(id) {
		return http.StatusBadRequest, errors.New("invalid note ID format")
	}

	isOwner, err := h.noteStore.IsOwner(id, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !isOwner {
		return http.StatusForbidden, errors.New("not owner")
	}

	shares, err := h.noteStore.GetNoteShares(id)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(shares); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

// SearchUsers godoc
//
//	@Summary	List users (excluding current user)
//	@Tags		users
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{array}		UserInfo
//	@Failure	401	{string}	string	"unauthorized"
//	@Router		/users [get]
func (h *NotesHandler) SearchUsers(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	users, err := h.userStore.GetAll()
	if err != nil {
		return http.StatusInternalServerError, err
	}

	userInfos := []UserInfo{}
	for _, user := range users {
		// Don't include the current user in the list
		if user.ID != currentUser.ID {
			userInfos = append(userInfos, UserInfo{
				ID:             user.ID,
				Username:       user.Username,
				FirstName:      user.FirstName,
				LastName:       user.LastName,
				Role:           user.Role,
				HasProfileIcon: user.HasProfileIcon,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(userInfos); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

type keepNoteItem struct {
	Text      string `json:"text"`
	IsChecked bool   `json:"isChecked"`
}

type keepNote struct {
	Title       string         `json:"title"`
	TextContent string         `json:"textContent"`
	ListContent []keepNoteItem `json:"listContent"`
	Color       string         `json:"color"`
	IsTrashed   bool           `json:"isTrashed"`
	IsArchived  bool           `json:"isArchived"`
	IsPinned    bool           `json:"isPinned"`
}

func (kn keepNote) isEmpty() bool {
	return kn.Title == "" && kn.TextContent == "" && len(kn.ListContent) == 0
}

func keepColorToHex(color string) string {
	switch strings.ToUpper(color) {
	case "YELLOW":
		return "#fbbc04"
	case "GREEN", "TEAL":
		return "#34a853"
	case "BLUE", "CERULEAN":
		return "#4285f4"
	case "RED", "PINK":
		return "#ea4335"
	case "PURPLE", "GRAY", "GREY", "BROWN":
		return "#9aa0a6"
	default:
		return models.DefaultNoteColor
	}
}

func (h *NotesHandler) importKeepNote(userID string, kn keepNote) error {
	noteType := models.NoteTypeText
	if len(kn.ListContent) > 0 {
		noteType = models.NoteTypeTodo
	}

	color := keepColorToHex(kn.Color)

	note, err := h.noteStore.Create(userID, kn.Title, kn.TextContent, noteType, color)
	if err != nil {
		return err
	}

	if noteType == models.NoteTypeTodo {
		for i, item := range kn.ListContent {
			if _, err := h.noteStore.CreateItemWithCompleted(note.ID, item.Text, i, item.IsChecked, 0, ""); err != nil {
				return err
			}
		}
	}

	if kn.IsPinned || kn.IsArchived {
		if err := h.noteStore.Update(note.ID, userID, kn.Title, kn.TextContent, kn.IsPinned, kn.IsArchived, color, false); err != nil {
			return err
		}
	}

	return nil
}

const (
	keepImportMaxEntrySize = 1 << 20  // 1 MB per zip entry
	keepImportMaxTotalSize = 64 << 20 // 64 MB total decompressed
)

func parseKeepNotesFromZip(zr *zip.Reader) []keepNote {
	var notes []keepNote
	var totalRead int64
	for _, f := range zr.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".json") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		lr := &io.LimitedReader{R: rc, N: keepImportMaxEntrySize + 1}
		jsonData, err := io.ReadAll(lr)
		_ = rc.Close()
		totalRead += int64(len(jsonData))
		if totalRead > keepImportMaxTotalSize {
			break
		}
		if err != nil || lr.N == 0 {
			continue // read error or entry exceeded per-entry limit
		}
		var kn keepNote
		if err := json.Unmarshal(jsonData, &kn); err != nil {
			continue
		}
		if kn.isEmpty() {
			continue
		}
		notes = append(notes, kn)
	}
	return notes
}

func parseKeepNotesFromData(filename string, data []byte) ([]keepNote, error) {
	isZip := strings.HasSuffix(strings.ToLower(filename), ".zip") ||
		(len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && data[2] == 0x03 && data[3] == 0x04)

	if isZip {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, errors.New("invalid zip file")
		}
		return parseKeepNotesFromZip(zr), nil
	}

	var kn keepNote
	if err := json.Unmarshal(data, &kn); err != nil {
		return nil, errors.New("invalid JSON file")
	}
	if kn.isEmpty() {
		return nil, errors.New("note has no title, content, or list items")
	}
	return []keepNote{kn}, nil
}

func (h *NotesHandler) importKeepNotes(userID string, keepNotes []keepNote) (imported, skipped int, importErrors []string) {
	for i, kn := range keepNotes {
		if kn.IsTrashed {
			skipped++
			continue
		}
		if err := h.importKeepNote(userID, kn); err != nil {
			title := kn.Title
			if title == "" {
				title = fmt.Sprintf("note #%d", i+1)
			}
			importErrors = append(importErrors, fmt.Sprintf("failed to import %q: %v", title, err))
			continue
		}
		imported++
	}
	return imported, skipped, importErrors
}

// ImportNotes godoc
//
//	@Summary	Import notes from a Google Keep export
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		multipart/form-data
//	@Produce	json
//	@Param		file	formData	file			true	"Google Keep JSON or ZIP export file"
//	@Success	200		{object}	ImportResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Router		/notes/import [post]
func (h *NotesHandler) ImportNotes(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return http.StatusBadRequest, errors.New("failed to parse form")
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, errors.New("missing file")
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	keepNotes, err := parseKeepNotesFromData(header.Filename, data)
	if err != nil {
		return http.StatusBadRequest, err
	}

	imported, skipped, importErrors := h.importKeepNotes(user.ID, keepNotes)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(ImportResponse{Imported: imported, Skipped: skipped, Errors: importErrors}); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
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
//	@Router		/notes/reorder [post]
func (h *NotesHandler) ReorderNotes(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req ReorderNotesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if len(req.NoteIDs) == 0 {
		return http.StatusBadRequest, errors.New("empty note IDs list")
	}

	err := h.noteStore.ReorderNotes(user.ID, req.NoteIDs)
	if err != nil {
		if errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusForbidden, err
		}
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}
