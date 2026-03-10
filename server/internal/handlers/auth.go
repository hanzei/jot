package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type AuthHandler struct {
	userStore         *models.UserStore
	sessionService    *auth.SessionService
	userSettingsStore *models.UserSettingsStore
}

func NewAuthHandler(userStore *models.UserStore, sessionService *auth.SessionService, userSettingsStore *models.UserSettingsStore) *AuthHandler {
	return &AuthHandler{
		userStore:         userStore,
		sessionService:    sessionService,
		userSettingsStore: userSettingsStore,
	}
}

type RegisterRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type AuthResponse struct {
	User     *models.User         `json:"user"`
	Settings *models.UserSettings `json:"settings"`
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) (int, error) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validatePassword(req.Password); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.Create(req.Username, req.Password)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return http.StatusConflict, models.ErrUsernameTaken
		}
		return http.StatusInternalServerError, err
	}

	settings, err := h.userSettingsStore.GetOrCreate(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	err = h.sessionService.CreateSession(w, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		User:     user,
		Settings: settings,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) (int, error) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.Username == "" || req.Password == "" {
		return http.StatusBadRequest, ErrMissingCredentials
	}

	user, err := h.userStore.GetByUsername(req.Username)
	if err != nil {
		return http.StatusUnauthorized, ErrInvalidCredentials
	}

	if !user.CheckPassword(req.Password) {
		return http.StatusUnauthorized, ErrInvalidCredentials
	}

	settings, err := h.userSettingsStore.GetOrCreate(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	err = h.sessionService.InvalidateUserSessions(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	err = h.sessionService.CreateSession(w, user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		User:     user,
		Settings: settings,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) (int, error) {
	if err := h.sessionService.DeleteSession(w, r); err != nil {
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}

type UpdateUserRequest struct {
	Username string `json:"username"`
}

// UpdateUser handles PUT /api/v1/users/me. It validates the requested username,
// updates it in the database, and returns the updated user object. Returns 400
// for invalid format, 409 when the username is already taken, and 401 when the
// caller is not authenticated.
func (h *AuthHandler) UpdateUser(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, ErrUnauthorized
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.UpdateUsername(currentUser.ID, req.Username)
	if err != nil {
		if errors.Is(err, models.ErrUsernameTaken) {
			return http.StatusConflict, models.ErrUsernameTaken
		}
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{User: user}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, ErrUnauthorized
	}

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		return http.StatusBadRequest, ErrPasswordFieldsRequired
	}

	if err := validatePassword(req.NewPassword); err != nil {
		return http.StatusBadRequest, err
	}

	// Verify current password
	user, err := h.userStore.GetByID(currentUser.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if !user.CheckPassword(req.CurrentPassword) {
		return http.StatusForbidden, ErrIncorrectPassword
	}

	if err := h.userStore.UpdatePassword(currentUser.ID, req.NewPassword); err != nil {
		return http.StatusInternalServerError, err
	}

	// Invalidate all existing sessions so that stolen/compromised tokens
	// cannot be reused after a password change.
	if err := h.sessionService.InvalidateUserSessions(currentUser.ID); err != nil {
		return http.StatusInternalServerError, err
	}

	// Issue a fresh session for the current request so the user stays logged in.
	if err := h.sessionService.CreateSession(w, currentUser.ID); err != nil {
		return http.StatusInternalServerError, err
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) (int, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, ErrUnauthorized
	}

	settings, err := h.userSettingsStore.GetOrCreate(user.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	response := AuthResponse{
		User:     user,
		Settings: settings,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

type UpdateSettingsRequest struct {
	Language string `json:"language"`
}

var validLanguages = map[string]bool{"system": true, "en": true, "de": true}

// GetSettings handles GET /api/v1/users/me/settings.
func (h *AuthHandler) GetSettings(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, ErrUnauthorized
	}

	settings, err := h.userSettingsStore.GetOrCreate(currentUser.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(settings); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

// UpdateSettings handles PUT /api/v1/users/me/settings.
func (h *AuthHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, ErrUnauthorized
	}

	var req UpdateSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if !validLanguages[req.Language] {
		return http.StatusBadRequest, ErrInvalidLanguage
	}

	settings, err := h.userSettingsStore.Update(currentUser.ID, req.Language)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(settings); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}
