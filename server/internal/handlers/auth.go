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

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type AuthHandler struct {
	userStore           *models.UserStore
	sessionService      *auth.SessionService
	userSettingsStore   *models.UserSettingsStore
	registrationEnabled bool
}

func NewAuthHandler(userStore *models.UserStore, sessionService *auth.SessionService, userSettingsStore *models.UserSettingsStore, registrationEnabled bool) *AuthHandler {
	return &AuthHandler{
		userStore:           userStore,
		sessionService:      sessionService,
		userSettingsStore:   userSettingsStore,
		registrationEnabled: registrationEnabled,
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

// Register godoc
//
//	@Summary	Register a new user
//	@Tags		auth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		RegisterRequest	true	"Registration credentials"
//	@Success	201		{object}	AuthResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	403		{string}	string	"registration is disabled"
//	@Failure	409		{string}	string	"username already taken"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/register [post]
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) (int, any, error) {
	if !h.registrationEnabled {
		return http.StatusForbidden, nil, errors.New("registration is disabled")
	}

	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := validatePassword(req.Password); err != nil {
		return http.StatusBadRequest, nil, err
	}

	user, err := h.userStore.Create(req.Username, req.Password)
	if err != nil {
		if errors.Is(err, models.ErrUsernameTaken) {
			return http.StatusConflict, nil, models.ErrUsernameTaken
		}
		return http.StatusInternalServerError, nil, err
	}

	settings, err := h.userSettingsStore.GetOrCreate(user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	err = h.sessionService.CreateSession(w, r, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	response := AuthResponse{
		User:     user,
		Settings: settings,
	}

	return http.StatusCreated, response, nil
}

// Login godoc
//
//	@Summary	Authenticate a user
//	@Tags		auth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		LoginRequest	true	"Login credentials"
//	@Success	200		{object}	AuthResponse
//	@Failure	400		{string}	string	"missing username or password"
//	@Failure	401		{string}	string	"invalid username or password"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/login [post]
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) (int, any, error) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if req.Username == "" || req.Password == "" {
		return http.StatusBadRequest, nil, errors.New("missing username or password")
	}

	user, err := h.userStore.GetByUsername(req.Username)
	if err != nil {
		return http.StatusUnauthorized, nil, errors.New("invalid username or password")
	}

	if !user.CheckPassword(req.Password) {
		return http.StatusUnauthorized, nil, errors.New("invalid username or password")
	}

	settings, err := h.userSettingsStore.GetOrCreate(user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	err = h.sessionService.CreateSession(w, r, user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	response := AuthResponse{
		User:     user,
		Settings: settings,
	}

	return http.StatusOK, response, nil
}

// Logout godoc
//
//	@Summary	Log out the current user
//	@Tags		auth
//	@Security	CookieAuth
//	@Success	204	"no content"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/logout [post]
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) (int, any, error) {
	if err := h.sessionService.DeleteSession(w, r); err != nil {
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusNoContent, nil, nil
}

type UpdateUserRequest struct {
	Username  *string `json:"username,omitempty"`
	FirstName *string `json:"first_name,omitempty"`
	LastName  *string `json:"last_name,omitempty"`
	Language  *string `json:"language,omitempty" enums:"system,en,de"`
	Theme     *string `json:"theme,omitempty" enums:"system,light,dark"`
}

var validLanguages = map[string]bool{"system": true, "en": true, "de": true}
var validThemes = map[string]bool{"system": true, "light": true, "dark": true}

// validateSettingsFields validates language and theme. Returns (lang, theme, needUpdate).
// If both are nil, needUpdate is false. If validation fails, returns a non-nil error.
func validateSettingsFields(current *models.UserSettings, language, theme *string) (lang, th string, needUpdate bool, err error) {
	if language == nil && theme == nil {
		return "", "", false, nil
	}
	lang = current.Language
	if language != nil {
		lang = *language
	}
	if !validLanguages[lang] {
		return "", "", false, errors.New("invalid language: must be 'system', 'en', or 'de'")
	}
	th = current.Theme
	if theme != nil {
		th = *theme
	}
	if th == "" {
		th = "system"
	}
	if !validThemes[th] {
		return "", "", false, errors.New("invalid theme: must be 'system', 'light', or 'dark'")
	}
	return lang, th, true, nil
}

// applySettingsUpdate validates and persists language/theme changes.
// If neither field is set the current settings are returned unchanged.
func (h *AuthHandler) applySettingsUpdate(userID string, current *models.UserSettings, language, theme *string) (*models.UserSettings, int, error) {
	lang, th, needUpdate, err := validateSettingsFields(current, language, theme)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	if !needUpdate {
		return current, 0, nil
	}
	updated, err := h.userSettingsStore.Update(userID, lang, th)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return updated, 0, nil
}

// UpdateUser godoc
//
//	@Summary	Update the current user's profile and/or settings
//	@Tags		users
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		UpdateUserRequest	true	"Fields to update (all optional)"
//	@Success	200		{object}	AuthResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	409		{string}	string	"username already taken"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/users/me [patch]
func (h *AuthHandler) UpdateUser(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	username := currentUser.Username
	if req.Username != nil {
		username = *req.Username
	}
	if err := validateUsername(username); err != nil {
		return http.StatusBadRequest, nil, err
	}

	firstName := currentUser.FirstName
	if req.FirstName != nil {
		firstName = *req.FirstName
	}
	lastName := currentUser.LastName
	if req.LastName != nil {
		lastName = *req.LastName
	}

	// Validate settings before committing any changes so we fail atomically.
	settings, err := h.userSettingsStore.GetOrCreate(currentUser.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	if _, _, _, validateErr := validateSettingsFields(settings, req.Language, req.Theme); validateErr != nil {
		return http.StatusBadRequest, nil, validateErr
	}

	user, err := h.userStore.UpdateProfile(currentUser.ID, username, firstName, lastName)
	if err != nil {
		if errors.Is(err, models.ErrUsernameTaken) {
			return http.StatusConflict, nil, models.ErrUsernameTaken
		}
		return http.StatusInternalServerError, nil, err
	}

	settings, status, settingsErr := h.applySettingsUpdate(currentUser.ID, settings, req.Language, req.Theme)
	if settingsErr != nil {
		return status, nil, settingsErr
	}

	response := AuthResponse{User: user, Settings: settings}

	return http.StatusOK, response, nil
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// ChangePassword godoc
//
//	@Summary	Change the current user's password
//	@Tags		users
//	@Security	CookieAuth
//	@Accept		json
//	@Param		body	body	ChangePasswordRequest	true	"Password change"
//	@Success	204		"no content"
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"current password is incorrect"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/users/me/password [put]
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		return http.StatusBadRequest, nil, errors.New("current_password and new_password are required")
	}

	if err := validatePassword(req.NewPassword); err != nil {
		return http.StatusBadRequest, nil, err
	}

	// Verify current password
	user, err := h.userStore.GetByID(currentUser.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	if !user.CheckPassword(req.CurrentPassword) {
		return http.StatusForbidden, nil, errors.New("current password is incorrect")
	}

	if err := h.userStore.UpdatePassword(currentUser.ID, req.NewPassword); err != nil {
		return http.StatusInternalServerError, nil, err
	}

	// Invalidate all existing sessions so that stolen/compromised tokens
	// cannot be reused after a password change.
	if err := h.sessionService.InvalidateUserSessions(currentUser.ID); err != nil {
		return http.StatusInternalServerError, nil, err
	}

	// Issue a fresh session for the current request so the user stays logged in.
	if err := h.sessionService.CreateSession(w, r, currentUser.ID); err != nil {
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusNoContent, nil, nil
}

// Me godoc
//
//	@Summary	Get the current authenticated user and settings
//	@Tags		auth
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	AuthResponse
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/me [get]
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	settings, err := h.userSettingsStore.GetOrCreate(user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	response := AuthResponse{
		User:     user,
		Settings: settings,
	}

	return http.StatusOK, response, nil
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
	maxSourcePixels         = maxSourceDimension * maxSourceDimension // ~16 megapixels
)

// isOpaqueImage reports whether img is known to have no transparent pixels.
// It first checks the color model for inherently opaque formats (JPEG, CMYK,
// grayscale), then falls back to the Opaque() method that standard image types
// like *image.NRGBA and *image.RGBA implement.
func isOpaqueImage(model color.Model, img image.Image) bool {
	switch model {
	case color.YCbCrModel, color.CMYKModel, color.GrayModel, color.Gray16Model:
		return true
	}
	type opaquer interface{ Opaque() bool }
	if op, ok := img.(opaquer); ok {
		return op.Opaque()
	}
	return false
}

// flattenAlpha composites img onto a white background so that transparent
// regions render as white in the resulting opaque image.
func flattenAlpha(img image.Image) image.Image {
	b := img.Bounds()
	opaque := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(opaque, opaque.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(opaque, opaque.Bounds(), img, b.Min, draw.Over)
	return opaque
}

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

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}

	// Determine opaqueness from the config color model (before a potential
	// resize converts the image to RGBA and loses the original model info).
	sourceOpaque := isOpaqueImage(cfg.ColorModel, img)

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
		dstW = max(dstW, 1)
		dstH = max(dstH, 1)

		dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Src, nil)
		img = dst
	}

	// JPEG does not support transparency. Flatten alpha onto a white background
	// so transparent regions render as white instead of black. Skip when the
	// original source was opaque (no alpha channel to flatten).
	encImg := img
	if !sourceOpaque {
		encImg = flattenAlpha(img)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, encImg, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}

	return buf.Bytes(), nil
}

// UploadProfileIcon godoc
//
//	@Summary	Upload a profile icon for the current user
//	@Tags		users
//	@Security	CookieAuth
//	@Accept		multipart/form-data
//	@Produce	json
//	@Param		file	formData	file			true	"Profile icon image (JPEG, PNG or WebP, max 5 MB)"
//	@Success	200		{object}	models.User
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/users/me/profile-icon [post]
func (h *AuthHandler) UploadProfileIcon(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	const fileLimit = int64(5 << 20)
	const overhead = int64(64 << 10)
	r.Body = http.MaxBytesReader(w, r.Body, fileLimit+overhead)
	if err := r.ParseMultipartForm(fileLimit); err != nil {
		return http.StatusBadRequest, nil, fmt.Errorf("file too large (max %d MB)", fileLimit>>20)
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, nil, errors.New("file is required")
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("failed to read file: %w", err)
	}

	contentType := http.DetectContentType(data)
	if !allowedImageTypes[contentType] {
		return http.StatusBadRequest, nil, errors.New("unsupported file type: must be jpeg, png, or webp")
	}

	data, err = resizeImage(data)
	if err != nil {
		return http.StatusBadRequest, nil, fmt.Errorf("unsupported or corrupt image: %w", err)
	}
	contentType = "image/jpeg"

	if err = h.userStore.UpdateProfileIcon(currentUser.ID, data, contentType); err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("update profile icon for user %s: %w", currentUser.ID, err)
	}

	user, err := h.userStore.GetByID(currentUser.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("fetch user by id: %w", err)
	}

	return http.StatusOK, user, nil
}

// DeleteProfileIcon godoc
//
//	@Summary	Delete the current user's profile icon
//	@Tags		users
//	@Security	CookieAuth
//	@Success	204	"no content"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/users/me/profile-icon [delete]
func (h *AuthHandler) DeleteProfileIcon(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	if err := h.userStore.DeleteProfileIcon(currentUser.ID); err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("delete profile icon for user %s: %w", currentUser.ID, err)
	}

	return http.StatusNoContent, nil, nil
}

// GetUserProfileIcon godoc
//
//	@Summary	Get a user's profile icon
//	@Tags		users
//	@Security	CookieAuth
//	@Produce	image/jpeg
//	@Param		id	path		string	true	"User ID"
//	@Success	200	{file}		binary	"JPEG image"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	404	{string}	string	"not found"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/users/{id}/profile-icon [get]
func (h *AuthHandler) GetUserProfileIcon(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id := chi.URLParam(r, "id")

	data, contentType, err := h.userStore.GetProfileIcon(id)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, nil, errors.New("user not found")
		}
		return http.StatusInternalServerError, nil, fmt.Errorf("fetch profile icon: %w", err)
	}
	if len(data) == 0 {
		return http.StatusNotFound, nil, errors.New("no profile icon set")
	}

	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := w.Write(data); err != nil { // #nosec G705 -- data is validated image bytes; MIME confirmed via http.DetectContentType at upload, Content-Type and X-Content-Type-Options: nosniff are set
		return http.StatusInternalServerError, nil, fmt.Errorf("failed to write response: %w", err)
	}
	return 0, nil, nil
}
