package handlers

import "net/http"

// UserInfo contains safe public fields returned when listing users for share-target search.
type UserInfo struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	FirstName      string `json:"first_name"`
	LastName       string `json:"last_name"`
	Role           string `json:"role"`
	HasProfileIcon bool   `json:"has_profile_icon"`
}

// UserSearchResponse is the GET /users body.
type UserSearchResponse struct {
	Users []UserInfo `json:"users"`
	// Truncated is true when a search matched more than 50 users and only the
	// first 50 are returned. Always false without a search term.
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
	currentUser, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	users, truncated, err := h.notes.ListUsers(r.Context(), currentUser.ID, r.URL.Query().Get("search"))
	if err != nil {
		return storeError(err, "list users")
	}

	userInfos := make([]UserInfo, 0, len(users))
	for _, user := range users {
		userInfos = append(userInfos, UserInfo{
			ID:             user.ID,
			Username:       user.Username,
			FirstName:      user.FirstName,
			LastName:       user.LastName,
			Role:           user.Role,
			HasProfileIcon: user.HasProfileIcon,
		})
	}

	return http.StatusOK, UserSearchResponse{Users: userInfos, Truncated: truncated}, nil
}
