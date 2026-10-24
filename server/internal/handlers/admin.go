package handlers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
)

type AdminHandler struct {
	userStore         *models.UserStore
	noteStore         *models.NoteStore
	statsStore        *models.AdminStatsStore
	userSettingsStore *models.UserSettingsStore
	imageStore        *blobstore.ImageStore
	sessionService    *auth.SessionService
	hub               *sse.Hub
	startedAt         time.Time
	passwordMinLength int
}

func NewAdminHandler(
	userStore *models.UserStore,
	noteStore *models.NoteStore,
	statsStore *models.AdminStatsStore,
	userSettingsStore *models.UserSettingsStore,
	imageStore *blobstore.ImageStore,
	sessionService *auth.SessionService,
	hub *sse.Hub,
	// startedAt must come from time.Now, not models.Now: the uptime is
	// measured against its monotonic clock reading, which models.Now strips.
	startedAt time.Time,
	passwordMinLength int,
) *AdminHandler {
	return &AdminHandler{
		userStore:         userStore,
		noteStore:         noteStore,
		statsStore:        statsStore,
		userSettingsStore: userSettingsStore,
		imageStore:        imageStore,
		sessionService:    sessionService,
		hub:               hub,
		startedAt:         startedAt,
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
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403	{object}	apierr.ErrorResponse	"forbidden"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/admin/stats [get]
func (h *AdminHandler) GetStats(w http.ResponseWriter, r *http.Request) (int, any, error) {
	stats, err := h.statsStore.GetStats(r.Context())
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	rt := &stats.Runtime
	rt.StartedAt = h.startedAt.UTC()
	// StartedAt keeps its monotonic reading, so a wall-clock step (NTP,
	// VM resume) cannot make the uptime jump or go negative.
	rt.UptimeSeconds = int64(time.Since(h.startedAt).Seconds())
	rt.SSESubscribers = int64(h.hub.SubscriberCount())
	// Unsupported platforms report the volume as unknown without a warning.
	if free, total, diskErr := h.imageStore.DiskUsage(); diskErr == nil {
		rt.UploadVolume = &models.AdminUploadVolumeStats{FreeBytes: free, TotalBytes: total}
	} else if !errors.Is(diskErr, blobstore.ErrDiskUsageUnsupported) {
		logutil.FromContext(r.Context()).WithError(diskErr).Warn("Failed to read upload directory disk usage")
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
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403	{object}	apierr.ErrorResponse	"forbidden"
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
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403		{object}	apierr.ErrorResponse	"forbidden"
//	@Failure	409		{object}	apierr.ErrorResponse	"username already taken"
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
		return storeError(err, "create user")
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
//	@Failure	400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403		{object}	apierr.ErrorResponse	"forbidden"
//	@Failure	404		{object}	apierr.ErrorResponse	"user not found"
//	@Failure	409		{object}	apierr.ErrorResponse	"cannot demote the last admin"
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
		return storeError(err, "update user role")
	}
	return http.StatusOK, user, nil
}

type SetUserPasswordRequest struct {
	NewPassword string `json:"new_password" validate:"required"`
}

// SetUserPassword godoc
//
//	@Summary		Set a user's password (admin only)
//	@Description	Sets a new password for the given user without requiring the user's current password. All of the target user's existing sessions are invalidated. Intended for administrative account recovery.
//	@Tags			admin
//	@Security		CookieAuth
//	@Accept			json
//	@Param			id		path	string					true	"User ID"
//	@Param			body	body	SetUserPasswordRequest	true	"New password"
//	@Success		204		"no content"
//	@Failure		400		{object}	apierr.ErrorResponse	"bad request"
//	@Failure		401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		403		{object}	apierr.ErrorResponse	"forbidden"
//	@Failure		404		{object}	apierr.ErrorResponse	"user not found"
//	@Router			/admin/users/{id}/password [put]
func (h *AdminHandler) SetUserPassword(w http.ResponseWriter, r *http.Request) (int, any, error) {
	requestingUser, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	targetID := chi.URLParam(r, "id")

	var req SetUserPasswordRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := validatePassword(req.NewPassword, h.passwordMinLength); err != nil {
		return http.StatusBadRequest, nil, err
	}

	if err := h.userStore.UpdatePassword(r.Context(), targetID, req.NewPassword); err != nil {
		return storeError(err, "update password")
	}

	// Invalidate the target user's existing sessions so no login can continue
	// with the old password after a reset.
	if err := h.sessionService.InvalidateUserSessions(r.Context(), targetID); err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("invalidate user sessions: %w", err)
	}

	// If the admin reset their own password, issue a fresh session so the
	// current request stays authenticated (mirrors AuthHandler.ChangePassword).
	if targetID == requestingUser.ID {
		if err := h.sessionService.CreateSession(w, r, requestingUser.ID); err != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("create session: %w", err)
		}
	}

	return http.StatusNoContent, nil, nil
}

// DeleteUser godoc
//
//	@Summary	Delete a user (admin only)
//	@Tags		admin
//	@Security	CookieAuth
//	@Param		id	path	string	true	"User ID"
//	@Success	204	"no content"
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	403	{object}	apierr.ErrorResponse	"forbidden"
//	@Failure	404	{object}	apierr.ErrorResponse	"user not found"
//	@Failure	409	{object}	apierr.ErrorResponse	"cannot demote the last admin"
//	@Router		/admin/users/{id} [delete]
func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) (int, any, error) {
	targetID := chi.URLParam(r, "id")
	requestingUser, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
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
		return storeError(err, "delete user")
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
//	@Failure	400	{object}	apierr.ErrorResponse	"bad request"
//	@Failure	401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/admin/users/{id}/notes [delete]
func (h *AdminHandler) DeleteUserNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	if _, authErr := requireUser(r); authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	targetID, idErr := pathID(r, "id", "user")
	if idErr != nil {
		return http.StatusBadRequest, nil, idErr
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
