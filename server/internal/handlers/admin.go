package handlers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/models"
)

type AdminHandler struct {
	userStore         *models.UserStore
	noteStore         *models.NoteStore
	statsStore        *models.AdminStatsStore
	userSettingsStore *models.UserSettingsStore
	imageStore        *blobstore.ImageStore
	dbPath            string
	passwordMinLength int
}

func NewAdminHandler(
	userStore *models.UserStore,
	noteStore *models.NoteStore,
	statsStore *models.AdminStatsStore,
	userSettingsStore *models.UserSettingsStore,
	imageStore *blobstore.ImageStore,
	dbPath string,
	passwordMinLength int,
) *AdminHandler {
	return &AdminHandler{
		userStore:         userStore,
		noteStore:         noteStore,
		statsStore:        statsStore,
		userSettingsStore: userSettingsStore,
		imageStore:        imageStore,
		dbPath:            dbPath,
		passwordMinLength: passwordMinLength,
	}
}

type CreateUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

type UserListResponse struct {
	Users []*models.User `json:"users"`
}

// GetStats godoc
//
//	@Summary	Get admin system stats (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	models.AdminStats
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"forbidden"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/admin/stats [get]
func (h *AdminHandler) GetStats(w http.ResponseWriter, r *http.Request) (int, any, error) {
	stats, err := h.statsStore.GetStats(r.Context())
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	// DatabaseSizeBytes is only meaningful for SQLite (file-based) installations.
	// For PostgreSQL (and any driver where dbPath is not a file path), os.Stat
	// will fail; in that case we leave the field at zero.
	if fileInfo, statErr := os.Stat(h.dbPath); statErr == nil {
		stats.Storage.DatabaseSizeBytes = fileInfo.Size()
	}

	return http.StatusOK, stats, nil
}

// GetUsers godoc
//
//	@Summary	List all users (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	UserListResponse
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"forbidden"
//	@Router		/admin/users [get]
func (h *AdminHandler) GetUsers(w http.ResponseWriter, r *http.Request) (int, any, error) {
	users, err := h.userStore.GetAll(r.Context())
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	response := UserListResponse{
		Users: users,
	}

	return http.StatusOK, response, nil
}

// CreateUser godoc
//
//	@Summary	Create a user (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		body	body		CreateUserRequest	true	"New user details"
//	@Success	201		{object}	models.User
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"forbidden"
//	@Failure	409		{string}	string	"username already taken"
//	@Router		/admin/users [post]
func (h *AdminHandler) CreateUser(w http.ResponseWriter, r *http.Request) (int, any, error) {
	var req CreateUserRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := validateUsername(req.Username); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := validatePassword(req.Password, h.passwordMinLength); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := validateRole(req.Role); err != nil {
		return http.StatusBadRequest, nil, err
	}

	user, err := h.userStore.CreateByAdmin(r.Context(), req.Username, req.Password, req.Role)
	if err != nil {
		if errors.Is(err, models.ErrUsernameTaken) {
			return http.StatusConflict, nil, models.ErrUsernameTaken
		}
		return http.StatusInternalServerError, nil, err
	}

	if _, err := h.userSettingsStore.GetOrCreate(r.Context(), user.ID); err != nil {
		return http.StatusInternalServerError, nil, err
	}

	return http.StatusCreated, user, nil
}

type UpdateUserRoleRequest struct {
	Role string `json:"role"`
}

// UpdateUserRole godoc
//
//	@Summary	Update a user's role (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		string					true	"User ID"
//	@Param		body	body		UpdateUserRoleRequest	true	"New role"
//	@Success	200		{object}	models.User
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	403		{string}	string	"forbidden"
//	@Failure	404		{string}	string	"user not found"
//	@Failure	409		{string}	string	"cannot demote the last admin"
//	@Router		/admin/users/{id}/role [put]
func (h *AdminHandler) UpdateUserRole(w http.ResponseWriter, r *http.Request) (int, any, error) {
	userID := chi.URLParam(r, "id")
	var req UpdateUserRoleRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}
	if err := validateRole(req.Role); err != nil {
		return http.StatusBadRequest, nil, err
	}
	user, err := h.userStore.UpdateRole(r.Context(), userID, req.Role)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, nil, err
		}
		if errors.Is(err, models.ErrLastAdmin) {
			return http.StatusConflict, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}
	return http.StatusOK, user, nil
}

// DeleteUser godoc
//
//	@Summary	Delete a user (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Param		id	path		string	true	"User ID"
//	@Success	204	"no content"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	403	{string}	string	"forbidden"
//	@Failure	404	{string}	string	"user not found"
//	@Failure	409	{string}	string	"cannot demote the last admin"
//	@Router		/admin/users/{id} [delete]
func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) (int, any, error) {
	targetID := chi.URLParam(r, "id")
	requestingUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	// Deleting the user cascades away both their owned notes' note_images
	// rows and any note_images rows where they're the uploader on someone
	// else's note (note_images.uploader_id also cascades), so the candidate
	// blob hashes must be read before the delete — afterward the rows are
	// gone and there's nothing left to look up. Reading via preDelete inside
	// DeleteWithCleanup's own transaction (rather than a separate query
	// beforehand) keeps the read atomic with the delete: a plain query run
	// before the call could miss an image added in the gap between the read
	// and the delete actually starting.
	var shas []string
	err := h.userStore.DeleteWithCleanup(r.Context(), targetID, requestingUser.ID,
		func(ctx context.Context, tx *sql.Tx) error {
			var err error
			shas, err = h.noteStore.GetNoteImageSHA256sForUserTx(ctx, tx, targetID)
			return err
		},
		func(ctx context.Context, tx *sql.Tx) error {
			return h.noteStore.ClearUserAssignmentsTx(ctx, tx, targetID)
		},
	)
	if err != nil {
		if errors.Is(err, models.ErrUserNotFound) {
			return http.StatusNotFound, nil, err
		}
		if errors.Is(err, models.ErrLastAdmin) {
			return http.StatusConflict, nil, err
		}
		if errors.Is(err, models.ErrCannotDeleteSelf) {
			return http.StatusForbidden, nil, err
		}
		return http.StatusInternalServerError, nil, err
	}

	reclaimOrphanedImageBlobs(r.Context(), h.noteStore, h.imageStore, shas)

	return http.StatusNoContent, nil, nil
}

// DeleteUserNotesResponse reports how many notes were removed.
type DeleteUserNotesResponse struct {
	Deleted int `json:"deleted"`
}

// DeleteUserNotes godoc
//
//	@Summary	Delete all notes owned by a user (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Produce	json
//	@Param		id	path		string	true	"User ID"
//	@Success	200	{object}	DeleteUserNotesResponse
//	@Failure	400	{string}	string	"bad request"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/admin/users/{id}/notes [delete]
func (h *AdminHandler) DeleteUserNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	if _, ok := auth.GetUserFromContext(r.Context()); !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	targetID := chi.URLParam(r, "id")
	if !models.IsValidID(targetID) {
		return http.StatusBadRequest, nil, errors.New("invalid user ID format")
	}

	deleted, shas, err := h.noteStore.DeleteAllByUser(r.Context(), targetID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("delete notes for user: %w", err)
	}
	reclaimOrphanedImageBlobs(r.Context(), h.noteStore, h.imageStore, shas)

	return http.StatusOK, DeleteUserNotesResponse{Deleted: deleted}, nil
}

func validateRole(role string) error {
	if role != models.RoleUser && role != models.RoleAdmin {
		return errors.New("invalid role: must be 'user' or 'admin'")
	}
	return nil
}
