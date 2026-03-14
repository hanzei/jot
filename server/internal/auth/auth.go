package auth

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/hanzei/jot/server/internal/models"
)

func cookieSecure() bool {
	v := os.Getenv("COOKIE_SECURE")
	return v != "false"
}

const (
	SessionCookieName = "jot_session"
)

type SessionService struct {
	sessionStore *models.SessionStore
	userStore    *models.UserStore
}

func NewSessionService(sessionStore *models.SessionStore, userStore *models.UserStore) *SessionService {
	return &SessionService{
		sessionStore: sessionStore,
		userStore:    userStore,
	}
}

func (s *SessionService) CreateSession(w http.ResponseWriter, userID string) error {
	session, err := s.sessionStore.Create(userID)
	if err != nil {
		return err
	}

	setSessionCookie(w, session.Token, int(models.SessionDuration.Seconds()))

	return nil
}

func (s *SessionService) DeleteSession(w http.ResponseWriter, r *http.Request) error {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return nil //nolint:nilerr // No cookie means no session to delete
	}

	if err := s.sessionStore.Delete(cookie.Value); err != nil {
		return err
	}

	setSessionCookie(w, "", -1)

	return nil
}

func (s *SessionService) InvalidateUserSessions(userID string) error {
	return s.sessionStore.DeleteByUserID(userID)
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

	session, err := s.sessionStore.GetByToken(cookie.Value)
	if err != nil {
		return nil, nil, err
	}

	user, err := s.userStore.GetByID(session.UserID)
	if err != nil {
		return nil, nil, err
	}

	return session, user, nil
}

func (s *SessionService) RenewSessionIfExpiringSoon(w http.ResponseWriter, session *models.Session) error {
	now := time.Now()
	if session.ExpiresAt.Sub(now) >= models.SessionRenewWindow {
		return nil
	}

	newExpiry := now.Add(models.SessionDuration)
	if err := s.sessionStore.UpdateExpiry(session.Token, newExpiry); err != nil {
		return fmt.Errorf("renew session: %w", err)
	}
	setSessionCookie(w, session.Token, int(models.SessionDuration.Seconds()))
	return nil
}

func setSessionCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   cookieSecure(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	})
}
