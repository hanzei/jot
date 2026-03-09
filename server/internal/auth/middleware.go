package auth

import (
	"context"
	"net/http"

	"github.com/hanzei/jot/server/internal/models"
)

type contextKey string

const UserContextKey contextKey = "user"

type UserClaims struct {
	UserID   string
	Username string
	Role     string
}

func (s *SessionService) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.GetSessionUser(r)
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		claims := &UserClaims{
			UserID:   user.ID,
			Username: user.Username,
			Role:     user.Role,
		}

		ctx := context.WithValue(r.Context(), UserContextKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetUserFromContext(ctx context.Context) (*UserClaims, bool) {
	claims, ok := ctx.Value(UserContextKey).(*UserClaims)
	return claims, ok
}

func AdminRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := GetUserFromContext(r.Context())
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		if claims.Role != models.RoleAdmin {
			http.Error(w, "Admin required", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}
