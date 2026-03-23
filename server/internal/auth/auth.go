package auth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/models"
)
const (
	SessionCookieName = "jot_session"
)

type SessionService struct {
	sessionStore *models.SessionStore
	userStore    *models.UserStore
	cookieSecure bool
}

func NewSessionService(sessionStore *models.SessionStore, userStore *models.UserStore, cookieSecure bool) *SessionService {
	return &SessionService{
		sessionStore: sessionStore,
		userStore:    userStore,
		cookieSecure: cookieSecure,
	}
}

func (s *SessionService) CreateSession(w http.ResponseWriter, r *http.Request, userID string) error {
	userAgent := r.UserAgent()
	session, err := s.sessionStore.Create(r.Context(), userID, userAgent)
	if err != nil {
		return err
	}

	s.setSessionCookie(w, session.Token, int(models.SessionDuration.Seconds()))

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

func (s *SessionService) GetSessionAndUser(r *http.Request) (*models.Session, *models.User, error) {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return nil, nil, err
	}

	session, err := s.sessionStore.GetByToken(r.Context(), cookie.Value)
	if err != nil {
		return nil, nil, err
	}

	user, err := s.userStore.GetByID(r.Context(), session.UserID)
	if err != nil {
		return nil, nil, err
	}

	return session, user, nil
}

func (s *SessionService) RenewSessionIfExpiringSoon(ctx context.Context, w http.ResponseWriter, session *models.Session) error {
	now := time.Now()
	if session.ExpiresAt.Sub(now) >= models.SessionRenewWindow {
		return nil
	}

	newExpiry := now.Add(models.SessionDuration)
	if err := s.sessionStore.UpdateExpiry(ctx, session.Token, newExpiry); err != nil {
		return fmt.Errorf("renew session: %w", err)
	}
	s.setSessionCookie(w, session.Token, int(models.SessionDuration.Seconds()))
	return nil
}

func (s *SessionService) setSessionCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	})
}
