package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type contextKey string

const UserContextKey contextKey = "user"
const SessionTokenContextKey contextKey = "session_token"

func (s *SessionService) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try cookie-based session first.
		if _, err := r.Cookie(SessionCookieName); err == nil {
			session, user, err := s.GetSessionAndUser(r)
			if err != nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			if err := s.RenewSessionIfExpiringSoon(r.Context(), w, session); err != nil {
				logutil.FromContext(r.Context()).WithError(err).Warn("Failed to renew session")
			}

			logutil.FromContext(r.Context()).AddField("user_id", user.ID)
			trace.SpanFromContext(r.Context()).SetAttributes(attribute.String("user.id", user.ID))

			ctx := context.WithValue(r.Context(), UserContextKey, user)
			ctx = context.WithValue(ctx, SessionTokenContextKey, session.Token)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		// Fall back to Bearer token (personal access token).
		if authHeader := r.Header.Get("Authorization"); strings.HasPrefix(authHeader, "Bearer ") {
			rawToken := strings.TrimPrefix(authHeader, "Bearer ")
			user, err := s.authenticateWithPAT(r.Context(), rawToken)
			if err != nil {
				switch {
				case errors.Is(err, models.ErrPATExpired):
					// Audit-level info: an operator watching for compromised
					// tokens needs to see every expired-PAT rejection.
					logutil.FromContext(r.Context()).
						WithField("event", "pat_expired_rejected").
						Warn("Rejected expired personal access token")
				case errors.Is(err, models.ErrPATNotFound):
					// Do nothing — common case for clients probing with a
					// stale or typo'd token.
				default:
					logutil.FromContext(r.Context()).WithError(err).Warn("PAT authentication error")
				}
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			logutil.FromContext(r.Context()).AddField("user_id", user.ID)
			trace.SpanFromContext(r.Context()).SetAttributes(attribute.String("user.id", user.ID))

			ctx := context.WithValue(r.Context(), UserContextKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	})
}

func (s *SessionService) authenticateWithPAT(ctx context.Context, rawToken string) (_ *models.User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "SessionService.authenticateWithPAT", &err)
	defer end()
	pat, err := s.patStore.GetByTokenHash(ctx, rawToken)
	if err != nil {
		return nil, err
	}
	user, err := s.userStore.GetByID(ctx, pat.UserID)
	if err != nil {
		return nil, fmt.Errorf("get user for PAT: %w", err)
	}
	return user, nil
}

func GetUserFromContext(ctx context.Context) (*models.User, bool) {
	user, ok := ctx.Value(UserContextKey).(*models.User)
	return user, ok
}

func GetSessionTokenFromContext(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(SessionTokenContextKey).(string)
	return token, ok
}

// SessionRequired is a middleware that ensures the request was authenticated
// with a browser session cookie, not a personal access token. Use this to
// protect sensitive account management endpoints (e.g. PAT management) that
// should not be accessible via PAT Bearer auth to limit the blast radius of a
// leaked token.
func SessionRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, ok := GetSessionTokenFromContext(r.Context())
		if !ok {
			http.Error(w, "session authentication required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
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
