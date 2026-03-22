package handlers

import (
	"errors"
	"net/http"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
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

// SearchUsers godoc
//
//	@Summary	Search or list users (excluding current user)
//	@Tags		users
//	@Security	CookieAuth
//	@Produce	json
//	@Param		search	query		string	false	"Filter by username, first name, or last name (case-insensitive substring match)"
//	@Success	200		{array}		UserInfo
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/users [get]
func (h *NotesHandler) SearchUsers(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	search := r.URL.Query().Get("search")

	var users []*models.User
	var err error
	if search != "" {
		users, err = h.userStore.Search(r.Context(), search)
	} else {
		users, err = h.userStore.GetAll(r.Context())
	}
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	userInfos := []UserInfo{}
	for _, user := range users {
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

	return http.StatusOK, userInfos, nil
}
