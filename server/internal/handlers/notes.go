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
}

func (h *NotesHandler) createTodoItems(noteID string, items []CreateNoteItem) (int, error) {
	for _, item := range items {
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return http.StatusBadRequest, errors.New("indent_level must be 0 or 1")
		}
		if _, err := h.noteStore.CreateItem(noteID, item.Text, item.Position, item.IndentLevel); err != nil {
			return http.StatusInternalServerError, err
		}
	}
	return 0, nil
}

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

func (h *NotesHandler) CreateNote(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req CreateNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

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

func (h *NotesHandler) validateAndUpdateTodoItems(noteID string, userID string, items []UpdateNoteItem) (int, error) {
	for _, item := range items {
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return http.StatusBadRequest, errors.New("indent_level must be 0 or 1")
		}
	}
	return 0, h.updateTodoItems(noteID, userID, items)
}

func (h *NotesHandler) updateTodoItems(noteID string, userID string, items []UpdateNoteItem) error {
	// Get current note to check if it's a todo type
	currentNote, err := h.noteStore.GetByID(noteID, userID)
	if err != nil {
		return err
	}

	if currentNote.NoteType == models.NoteTypeTodo {
		// Delete all existing items (we'll recreate them)
		if err := h.noteStore.DeleteItemsByNoteID(noteID); err != nil {
			return err
		}

		// Create new items with updated positions
		for _, item := range items {
			_, err := h.noteStore.CreateItemWithCompleted(noteID, item.Text, item.Position, item.Completed, item.IndentLevel)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

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

	err := h.noteStore.Update(id, user.ID, req.Title, req.Content, req.Pinned, req.Archived, req.Color, req.CheckedItemsCollapsed)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotFound) || errors.Is(err, models.ErrNoteNoAccess) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	// Handle todo items update if provided
	if len(req.Items) > 0 {
		var status int
		status, err = h.validateAndUpdateTodoItems(id, user.ID, req.Items)
		if err != nil {
			return status, err
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

	// Fetch audience before trashing so we can notify share targets too.
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(id)

	err := h.noteStore.MoveToTrash(id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotOwnedByUser) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
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

func (h *NotesHandler) PermanentlyDeleteNote(w http.ResponseWriter, r *http.Request) (int, error) {
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

	// Fetch audience before deletion so we can notify share targets too.
	audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(id)

	err := h.noteStore.DeleteFromTrash(id, user.ID)
	if err != nil {
		if errors.Is(err, models.ErrNoteNotInTrash) {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
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

type ShareNoteRequest struct {
	Username string `json:"username"`
}

type ShareNoteResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

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
		if strings.Contains(err.Error(), "UNIQUE constraint failed: note_shares.note_id, note_shares.shared_with_user_id") {
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
// @Summary List users (excluding current user)
func (h *NotesHandler) SearchUsers(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	users, err := h.userStore.GetAll()
	if err != nil {
		return http.StatusInternalServerError, err
	}

	// Filter out passwords and only return safe fields for sharing purposes
	type UserInfo struct {
		ID             string `json:"id"`
		Username       string `json:"username"`
		FirstName      string `json:"first_name"`
		LastName       string `json:"last_name"`
		Role           string `json:"role"`
		HasProfileIcon bool   `json:"has_profile_icon"`
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
	Title                    string         `json:"title"`
	TextContent              string         `json:"textContent"`
	ListContent              []keepNoteItem `json:"listContent"`
	Color                    string         `json:"color"`
	IsTrashed                bool           `json:"isTrashed"`
	IsArchived               bool           `json:"isArchived"`
	IsPinned                 bool           `json:"isPinned"`
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
			if _, err := h.noteStore.CreateItemWithCompleted(note.ID, item.Text, i, item.IsChecked, 0); err != nil {
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

func parseKeepNotesFromZip(zr *zip.Reader) []keepNote {
	var notes []keepNote
	for _, f := range zr.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".json") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		jsonData, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			continue
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
