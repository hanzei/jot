package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
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
			return http.StatusConflict, errors.New("username already taken")
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
		return http.StatusBadRequest, errors.New("missing username or password")
	}

	user, err := h.userStore.GetByUsername(req.Username)
	if err != nil {
		return http.StatusUnauthorized, errors.New("invalid username or password")
	}

	if !user.CheckPassword(req.Password) {
		return http.StatusUnauthorized, errors.New("invalid username or password")
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
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

// UpdateUser handles PUT /api/v1/users/me. It validates the requested username,
// updates it in the database, and returns the updated user object. Returns 400
// for invalid format, 409 when the username is already taken, and 401 when the
// caller is not authenticated.
func (h *AuthHandler) UpdateUser(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, err
	}

	user, err := h.userStore.UpdateProfile(currentUser.ID, req.Username, req.FirstName, req.LastName)
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
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		return http.StatusBadRequest, errors.New("current_password and new_password are required")
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
		return http.StatusForbidden, errors.New("current password is incorrect")
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
		return http.StatusUnauthorized, errors.New("unauthorized")
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
	Theme    string `json:"theme"`
}

var validLanguages = map[string]bool{"system": true, "en": true, "de": true}
var validThemes = map[string]bool{"system": true, "light": true, "dark": true}

// GetSettings handles GET /api/v1/users/me/settings.
func (h *AuthHandler) GetSettings(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
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
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	var req UpdateSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, err
	}

	if !validLanguages[req.Language] {
		return http.StatusBadRequest, errors.New("invalid language: must be 'system', 'en', or 'de'")
	}

	if req.Theme == "" {
		req.Theme = "system"
	}
	if !validThemes[req.Theme] {
		return http.StatusBadRequest, errors.New("invalid theme: must be 'system', 'light', or 'dark'")
	}

	settings, err := h.userSettingsStore.Update(currentUser.ID, req.Language, req.Theme)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(settings); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

var allowedImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
}

const (
	maxProfileIconDimension = 256
	jpegQuality             = 85
	maxSourceDimension      = 4096
	maxSourcePixels         = 4096 * 4096 // ~16 megapixels
)

// resizeImage decodes the given image bytes, resizes to fit within
// maxProfileIconDimension x maxProfileIconDimension (preserving aspect ratio),
// and re-encodes as JPEG. If the image is already small enough it is still
// re-encoded as JPEG to normalize the format and compress.
func resizeImage(data []byte) ([]byte, error) {
	// Decode only the header to check dimensions before allocating the full image.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image config: %w", err)
	}
	if cfg.Width > maxSourceDimension || cfg.Height > maxSourceDimension {
		return nil, fmt.Errorf("image dimensions %dx%d exceed maximum %d", cfg.Width, cfg.Height, maxSourceDimension)
	}
	if cfg.Width*cfg.Height > maxSourcePixels {
		return nil, fmt.Errorf("image pixel count %d exceeds maximum %d", cfg.Width*cfg.Height, maxSourcePixels)
	}

	// Check whether the source is opaque using the config color model (before
	// a potential resize converts the image to RGBA and loses this info).
	sourceOpaque := false
	switch cfg.ColorModel {
	case color.YCbCrModel, color.CMYKModel, color.GrayModel, color.Gray16Model:
		sourceOpaque = true
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}

	bounds := img.Bounds()
	srcW := bounds.Dx()
	srcH := bounds.Dy()

	if srcW > maxProfileIconDimension || srcH > maxProfileIconDimension {
		var dstW, dstH int
		if srcW >= srcH {
			dstW = maxProfileIconDimension
			dstH = srcH * maxProfileIconDimension / srcW
		} else {
			dstH = maxProfileIconDimension
			dstW = srcW * maxProfileIconDimension / srcH
		}
		if dstW < 1 {
			dstW = 1
		}
		if dstH < 1 {
			dstH = 1
		}

		dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Src, nil)
		img = dst
	}

	// JPEG does not support transparency. Flatten alpha onto a white background
	// so transparent regions render as white instead of black. Skip when the
	// original source was opaque (no alpha channel to flatten).
	encImg := img
	if sourceOpaque {
		// Already opaque — encode directly.
	} else {
		b := img.Bounds()
		opaque := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
		draw.Draw(opaque, opaque.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
		draw.Draw(opaque, opaque.Bounds(), img, b.Min, draw.Over)
		encImg = opaque
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, encImg, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}

	return buf.Bytes(), nil
}

// UploadProfileIcon handles POST /api/v1/users/me/profile-icon.
// It accepts a multipart form with a single "file" field (max 5 MB, images only),
// stores the image in the database, and returns the updated User.
func (h *AuthHandler) UploadProfileIcon(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	const fileLimit = int64(5 << 20)
	const overhead = int64(64 << 10)
	r.Body = http.MaxBytesReader(w, r.Body, fileLimit+overhead)
	if err := r.ParseMultipartForm(fileLimit); err != nil {
		return http.StatusBadRequest, fmt.Errorf("file too large (max %d MB)", fileLimit>>20)
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, errors.New("file is required")
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("failed to read file: %w", err)
	}

	contentType := http.DetectContentType(data)
	if !allowedImageTypes[contentType] {
		return http.StatusBadRequest, errors.New("unsupported file type: must be jpeg, png, or webp")
	}

	data, err = resizeImage(data)
	if err != nil {
		return http.StatusBadRequest, fmt.Errorf("unsupported or corrupt image: %w", err)
	}
	contentType = "image/jpeg"

	if err = h.userStore.UpdateProfileIcon(currentUser.ID, data, contentType); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("update profile icon for user %s: %w", currentUser.ID, err)
	}

	user, err := h.userStore.GetByID(currentUser.ID)
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("fetch user by id: %w", err)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(user); err != nil {
		return http.StatusInternalServerError, err
	}
	return 0, nil
}

// DeleteProfileIcon handles DELETE /api/v1/users/me/profile-icon.
func (h *AuthHandler) DeleteProfileIcon(w http.ResponseWriter, r *http.Request) (int, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, errors.New("unauthorized")
	}

	if err := h.userStore.DeleteProfileIcon(currentUser.ID); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("delete profile icon for user %s: %w", currentUser.ID, err)
	}

	w.WriteHeader(http.StatusNoContent)
	return 0, nil
}

// GetUserProfileIcon handles GET /api/v1/users/{id}/profile-icon.
func (h *AuthHandler) GetUserProfileIcon(w http.ResponseWriter, r *http.Request) (int, error) {
	id := chi.URLParam(r, "id")

	data, contentType, err := h.userStore.GetProfileIcon(id)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, errors.New("user not found")
		}
		return http.StatusInternalServerError, fmt.Errorf("fetch profile icon: %w", err)
	}
	if len(data) == 0 {
		return http.StatusNotFound, errors.New("no profile icon set")
	}

	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := w.Write(data); err != nil { // #nosec G705 -- data is validated image bytes; MIME confirmed via http.DetectContentType at upload, Content-Type and X-Content-Type-Options: nosniff are set
		return http.StatusInternalServerError, fmt.Errorf("failed to write response: %w", err)
	}
	return 0, nil
}
