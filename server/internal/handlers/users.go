package handlers

import (
	"errors"
	"fmt"
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

// userSearchLimit caps GET /users?search=: the pickers that search are
// typeahead lists, so more rows than this only means the term needs refining.
// Listing without a term is not capped, since clients use it to resolve
// user IDs to names and avatars.
const userSearchLimit = 50

// UserSearchResponse is the GET /users body.
type UserSearchResponse struct {
	Users []UserInfo `json:"users"`
	// Truncated is true when a search matched more than userSearchLimit users
	// and only the first userSearchLimit are returned. Always false without a
	// search term.
	Truncated bool `json:"truncated"`
}

// SearchUsers godoc
//
//	@Summary		Search or list users (excluding current user)
//	@Description	With `search`, returns at most 50 matches, newest first, and sets `truncated` when there were more. Without it, returns every user.
//	@Tags			users
//	@Security		CookieAuth
//	@Produce		json
//	@Param			search	query		string	false	"Filter by username, first name, or last name (case-insensitive substring match)"
//	@Success		200		{object}	UserSearchResponse
//	@Failure		400		{object}	apierr.ErrorResponse	"search query too long"
//	@Failure		401		{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		500		{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/users [get]
func (h *NotesHandler) SearchUsers(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	search := r.URL.Query().Get("search")

	if err := validateSearchQuery(search); err != nil {
		return http.StatusBadRequest, nil, err
	}

	var users []*models.User
	var err error
	truncated := false
	if search != "" {
		// One extra row tells a result of exactly the limit apart from a
		// truncated one.
		users, err = h.userStore.Search(r.Context(), search, currentUser.ID, userSearchLimit+1)
		if err != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("search users: %w", err)
		}
		if len(users) > userSearchLimit {
			users = users[:userSearchLimit]
			truncated = true
		}
	} else {
		users, err = h.userStore.GetAll(r.Context())
		if err != nil {
			return http.StatusInternalServerError, nil, fmt.Errorf("get all users: %w", err)
		}
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

	return http.StatusOK, UserSearchResponse{Users: userInfos, Truncated: truncated}, nil
}
