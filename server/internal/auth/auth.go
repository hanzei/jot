package auth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/models"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)
const (
	SessionCookieName = "jot_session"
)

type SessionService struct {
	sessionStore *models.SessionStore
	userStore    *models.UserStore
	patStore     *models.PATStore
	cookieSecure bool
	tracer       trace.Tracer
}

func NewSessionService(sessionStore *models.SessionStore, userStore *models.UserStore, patStore *models.PATStore, cookieSecure bool) *SessionService {
	return &SessionService{
		sessionStore: sessionStore,
		userStore:    userStore,
		patStore:     patStore,
		cookieSecure: cookieSecure,
		tracer:       otel.Tracer("github.com/hanzei/jot/server"),
	}
}

func (s *SessionService) CreateSession(w http.ResponseWriter, r *http.Request, userID string) error {
	userAgent := r.UserAgent()
	_, rawToken, err := s.sessionStore.Create(r.Context(), userID, userAgent)
	if err != nil {
		return fmt.Errorf("store session: %w", err)
	}

	s.setSessionCookie(w, rawToken, int(models.SessionDuration.Seconds()))

	return nil
}

func (s *SessionService) DeleteSession(w http.ResponseWriter, r *http.Request) error {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return nil //nolint:nilerr // No cookie means no session to delete
	}

	if err := s.sessionStore.Delete(r.Context(), cookie.Value); err != nil {
		return err
	}

	s.setSessionCookie(w, "", -1)

	return nil
}

func (s *SessionService) InvalidateUserSessions(ctx context.Context, userID string) error {
	return s.sessionStore.DeleteByUserID(ctx, userID)
}

func (s *SessionService) GetSessionUser(r *http.Request) (*models.User, error) {
	_, user, err := s.GetSessionAndUser(r)
	if err != nil {
		return nil, err
	}
	return user, nil
}

func (s *SessionService) GetSessionAndUser(r *http.Request) (_ *models.Session, _ *models.User, err error) {
	ctx, end := startSpan(r.Context(), s.tracer, "SessionService.GetSessionAndUser", &err)
	defer end()

	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return nil, nil, err
	}

	session, err := s.sessionStore.GetByToken(ctx, cookie.Value)
	if err != nil {
		return nil, nil, err
	}

	user, err := s.userStore.GetByID(ctx, session.UserID)
	if err != nil {
		return nil, nil, err
	}

	return session, user, nil
}

// RenewSessionIfExpiringSoon extends the session and re-sets the cookie when
// the session is close to expiry. rawToken is the token from the client's
// cookie; only its hash is stored, so the cookie value cannot be derived from
// the session record itself.
func (s *SessionService) RenewSessionIfExpiringSoon(ctx context.Context, w http.ResponseWriter, session *models.Session, rawToken string) error {
	now := time.Now()
	if session.ExpiresAt.Sub(now) >= models.SessionRenewWindow {
		return nil
	}

	newExpiry := now.Add(models.SessionDuration)
	if err := s.sessionStore.UpdateExpiry(ctx, session.TokenHash, newExpiry); err != nil {
		return fmt.Errorf("renew session: %w", err)
	}
	s.setSessionCookie(w, rawToken, int(models.SessionDuration.Seconds()))
	return nil
}

func (s *SessionService) setSessionCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cookieSecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
	})
}
