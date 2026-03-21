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

type PaginatedUsersResponse struct {
	Items      []UserInfo         `json:"items"`
	Pagination PaginationMetadata `json:"pagination"`
}

// SearchUsers godoc
//
//	@Summary	Search or list users (excluding current user)
//	@Tags		users
//	@Security	CookieAuth
//	@Produce	json
//	@Param		search	query		string	false	"Filter by username, first name, or last name (case-insensitive substring match)"
//	@Param		limit	query		int		false	"Page size (default 50, max 100)"
//	@Param		offset	query		int		false	"Page offset (default 0)"
//	@Success	200		{object}	PaginatedUsersResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	500		{string}	string	"internal server error"
//	@Router		/users [get]
func (h *NotesHandler) SearchUsers(w http.ResponseWriter, r *http.Request) (int, any, error) {
	currentUser, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	search := r.URL.Query().Get("search")

	page, err := parsePaginationParams(r)
	if err != nil {
		return http.StatusBadRequest, nil, err
	}

	users, hasMore, err := h.userStore.GetPage(search, currentUser.ID, page.Limit, page.Offset)
	if err != nil {
		return http.StatusInternalServerError, nil, err
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

	return http.StatusOK, PaginatedUsersResponse{
		Items:      userInfos,
		Pagination: newPaginationMetadata(page, len(userInfos), hasMore),
	}, nil
}
