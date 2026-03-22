package auth

import (
	"context"
	"net/http"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/sirupsen/logrus"
)

type contextKey string

const UserContextKey contextKey = "user"
const SessionTokenContextKey contextKey = "session_token"

func (s *SessionService) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session, user, err := s.GetSessionAndUser(r)
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if err := s.RenewSessionIfExpiringSoon(r.Context(), w, session); err != nil {
			logrus.WithError(err).Warn("failed to renew session")
		}

		ctx := context.WithValue(r.Context(), UserContextKey, user)
		ctx = context.WithValue(ctx, SessionTokenContextKey, session.Token)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetUserFromContext(ctx context.Context) (*models.User, bool) {
	user, ok := ctx.Value(UserContextKey).(*models.User)
	return user, ok
}

func GetSessionTokenFromContext(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(SessionTokenContextKey).(string)
	return token, ok
}

func AdminRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := GetUserFromContext(r.Context())
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		if user.Role != models.RoleAdmin {
			http.Error(w, "Admin required", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}
