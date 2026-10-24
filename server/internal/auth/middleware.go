package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type contextKey string

const userContextKey contextKey = "user"

// sessionTokenHashContextKey carries the SHA-256 hash of the current
// session's token (the form sessions are stored in). The raw token never
// enters the request context.
const sessionTokenHashContextKey contextKey = "session_token_hash"

func (s *SessionService) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		hasBearer := strings.HasPrefix(authHeader, "Bearer ")

		// Try cookie-based session first. A rejected cookie (typically a
		// stale one left over from an expired or revoked session) falls
		// through to a bearer token when the request also carries one.
		if cookie, err := r.Cookie(SessionCookieName); err == nil {
			session, user, err := s.GetSessionAndUser(r)
			if err == nil {
				if renewErr := s.RenewSessionIfExpiringSoon(r.Context(), w, session, cookie.Value); renewErr != nil {
					logutil.FromContext(r.Context()).WithError(renewErr).Warn("Failed to renew session")
				}
				ctx := context.WithValue(withUser(r.Context(), user), sessionTokenHashContextKey, session.TokenHash)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			logSessionRejection(r.Context(), err)
			if !hasBearer {
				apierr.Write(w, r, http.StatusUnauthorized, apierr.CodeUnauthorized, "unauthorized")
				return
			}
		}

		// Fall back to Bearer token (personal access token).
		if hasBearer {
			rawToken := strings.TrimPrefix(authHeader, "Bearer ")
			user, err := s.authenticateWithPAT(r.Context(), rawToken)
			if err != nil {
				logPATRejection(r.Context(), err)
				apierr.Write(w, r, http.StatusUnauthorized, apierr.CodeUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r.WithContext(withUser(r.Context(), user)))
			return
		}

		logutil.FromContext(r.Context()).Debug("Auth rejected: no session cookie or bearer token")
		apierr.Write(w, r, http.StatusUnauthorized, apierr.CodeUnauthorized, "unauthorized")
	})
}

// withUser records the authenticated user on the request log fields and span
// and returns ctx carrying it.
func withUser(ctx context.Context, user *models.User) context.Context {
	logutil.FromContext(ctx).AddField("user_id", user.ID)
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("user.id", user.ID))
	return context.WithValue(ctx, userContextKey, user)
}

// logSessionRejection records why a session cookie was rejected. An unknown
// or expired session is routine (debug); anything else is a server-side
// failure.
func logSessionRejection(ctx context.Context, err error) {
	if errors.Is(err, models.ErrSessionNotFoundOrExpired) {
		logutil.FromContext(ctx).Debug("Auth rejected: session not found or expired")
		return
	}
	logutil.FromContext(ctx).WithError(err).Warn("Session authentication error")
}

// logPATRejection records why a bearer token was rejected. An unknown or
// revoked token is routine (debug); anything else is a server-side failure.
func logPATRejection(ctx context.Context, err error) {
	if errors.Is(err, models.ErrPATNotFound) {
		logutil.FromContext(ctx).Debug("Auth rejected: personal access token not found or revoked")
		return
	}
	logutil.FromContext(ctx).WithError(err).Warn("PAT authentication error")
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
	user, ok := ctx.Value(userContextKey).(*models.User)
	return user, ok
}

// GetSessionTokenHashFromContext returns the stored hash of the current
// session's token, present only for cookie-authenticated requests.
func GetSessionTokenHashFromContext(ctx context.Context) (string, bool) {
	tokenHash, ok := ctx.Value(sessionTokenHashContextKey).(string)
	return tokenHash, ok
}

// SessionRequired is a middleware that ensures the request was authenticated
// with a browser session cookie, not a personal access token. Use this to
// protect sensitive account management endpoints (e.g. PAT management) that
// should not be accessible via PAT Bearer auth to limit the blast radius of a
// leaked token.
func SessionRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, ok := GetSessionTokenHashFromContext(r.Context())
		if !ok {
			logutil.FromContext(r.Context()).Debug("Auth rejected: endpoint requires a session, not a personal access token")
			apierr.Write(w, r, http.StatusForbidden, apierr.CodeSessionRequired, "session authentication required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func AdminRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := GetUserFromContext(r.Context())
		if !ok {
			apierr.Write(w, r, http.StatusUnauthorized, apierr.CodeUnauthorized, "unauthorized")
			return
		}

		if user.Role != models.RoleAdmin {
			logutil.FromContext(r.Context()).WithField("role", user.Role).Debug("Auth rejected: admin role required")
			apierr.Write(w, r, http.StatusForbidden, apierr.CodeForbidden, "admin required")
			return
		}

		next.ServeHTTP(w, r)
	})
}
