package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type NotesHandler struct {
	noteStore *models.NoteStore
	userStore *models.UserStore
}

func NewNotesHandler(noteStore *models.NoteStore, userStore *models.UserStore) *NotesHandler {
	return &NotesHandler{
		noteStore: noteStore,
		userStore: userStore,
	}
}

type CreateNoteRequest struct {
	Title    string           `json:"title"`
	Content  string           `json:"content"`
	NoteType models.NoteType  `json:"note_type"`
	Color    string           `json:"color,omitempty"`
	Items    []CreateNoteItem `json:"items,omitempty"`
}

type CreateNoteItem struct {
	Text     string `json:"text"`
	Position int    `json:"position"`
}

type UpdateNoteRequest struct {
	Title    string           `json:"title"`
	Content  string           `json:"content"`
	Pinned   bool             `json:"pinned"`
	Archived bool             `json:"archived"`
	Color    string           `json:"color"`
	Items    []UpdateNoteItem `json:"items,omitempty"`
}

type UpdateNoteItem struct {
	Text      string `json:"text"`
	Position  int    `json:"position"`
	Completed bool   `json:"completed"`
}

func (h *NotesHandler) GetNotes(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	archived := r.URL.Query().Get("archived") == "true"
	search := r.URL.Query().Get("search")

	notes, err := h.noteStore.GetByUserID(claims.UserID, archived, search)
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
	claims, ok := auth.GetUserFromContext(r.Context())
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

	if req.NoteType == "" {
		req.NoteType = models.NoteTypeText
	}

	if req.Color == "" {
		req.Color = "#ffffff"
	}

	note, err := h.noteStore.Create(claims.UserID, req.Title, req.Content, req.NoteType, req.Color)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if req.NoteType == models.NoteTypeTodo && len(req.Items) > 0 {
		for _, item := range req.Items {
			_, err := h.noteStore.CreateItem(note.ID, item.Text, item.Position)
			if err != nil {
				return http.StatusInternalServerError, err
			}
		}

		updatedNote, err := h.noteStore.GetByID(note.ID, claims.UserID)
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
	return 0, nil
}

func (h *NotesHandler) GetNote(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
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

	note, err := h.noteStore.GetByID(id, claims.UserID)
	if err != nil {
		if err.Error() == "note not found" {
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
			_, err := h.noteStore.CreateItemWithCompleted(noteID, item.Text, item.Position, item.Completed)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *NotesHandler) UpdateNote(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
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
		req.Color = "#ffffff"
	}

	err := h.noteStore.Update(id, claims.UserID, req.Title, req.Content, req.Pinned, req.Archived, req.Color)
	if err != nil {
		if err.Error() == "note not found or no access" || err.Error() == "note not found" {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	// Handle todo items update if provided
	if len(req.Items) > 0 {
		if err = h.updateTodoItems(id, claims.UserID, req.Items); err != nil {
			return http.StatusInternalServerError, err
		}
	}

	note, err := h.noteStore.GetByID(id, claims.UserID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(note); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *NotesHandler) DeleteNote(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
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

	err := h.noteStore.Delete(id, claims.UserID)
	if err != nil {
		if err.Error() == "note not found or not owned by user" {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}

type ShareNoteRequest struct {
	Email string `json:"email"`
}

type ShareNoteResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

func (h *NotesHandler) ShareNote(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
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

	if req.Email == "" {
		return http.StatusBadRequest, errors.New("empty email")
	}

	isOwner, err := h.noteStore.IsOwner(id, claims.UserID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !isOwner {
		return http.StatusForbidden, errors.New("not owner")
	}

	targetUser, err := h.userStore.SearchByEmail(req.Email)
	if err != nil {
		if err.Error() == "user not found" {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	if targetUser.ID == claims.UserID {
		return http.StatusBadRequest, errors.New("cannot share with self")
	}

	err = h.noteStore.ShareNote(id, claims.UserID, targetUser.ID)
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
	return 0, nil
}

func (h *NotesHandler) UnshareNote(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
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

	if req.Email == "" {
		return http.StatusBadRequest, errors.New("empty email")
	}

	isOwner, err := h.noteStore.IsOwner(id, claims.UserID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if !isOwner {
		return http.StatusForbidden, errors.New("not owner")
	}

	targetUser, err := h.userStore.SearchByEmail(req.Email)
	if err != nil {
		if err.Error() == "user not found" {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
	}

	err = h.noteStore.UnshareNote(id, targetUser.ID)
	if err != nil {
		if err.Error() == "note share not found" {
			return http.StatusNotFound, err
		}
		return http.StatusInternalServerError, err
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
	claims, ok := auth.GetUserFromContext(r.Context())
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

	isOwner, err := h.noteStore.IsOwner(id, claims.UserID)
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

func (h *NotesHandler) SearchUsers(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	users, err := h.userStore.GetAll()
	if err != nil {
		return http.StatusInternalServerError, err
	}

	// Filter out passwords and only return id, email, is_admin for sharing purposes
	type UserInfo struct {
		ID      string `json:"id"`
		Email   string `json:"email"`
		IsAdmin bool   `json:"is_admin"`
	}

	var userInfos []UserInfo
	for _, user := range users {
		// Don't include the current user in the list
		if user.ID != claims.UserID {
			userInfos = append(userInfos, UserInfo{
				ID:      user.ID,
				Email:   user.Email,
				IsAdmin: user.IsAdmin,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(userInfos); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

type ReorderNotesRequest struct {
	NoteIDs []string `json:"note_ids"`
}

func (h *NotesHandler) ReorderNotes(w http.ResponseWriter, r *http.Request) (int, error) {
	claims, ok := auth.GetUserFromContext(r.Context())
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

	err := h.noteStore.ReorderNotes(claims.UserID, req.NoteIDs)
	if err != nil {
		if strings.Contains(err.Error(), "no access") {
			return http.StatusForbidden, err
		}
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}
