package auth

import (
	"net/http"
	"os"

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

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    session.Token,
		Path:     "/",
		HttpOnly: true,
		Secure:   cookieSecure(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(models.SessionDuration.Seconds()),
	})

	return nil
}

func (s *SessionService) DeleteSession(w http.ResponseWriter, r *http.Request) error {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return nil // No session to delete
	}

	if err := s.sessionStore.Delete(cookie.Value); err != nil {
		return err
	}

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   cookieSecure(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})

	return nil
}

func (s *SessionService) InvalidateUserSessions(userID string) error {
	return s.sessionStore.DeleteByUserID(userID)
}

func (s *SessionService) GetSessionUser(r *http.Request) (*models.User, error) {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return nil, err
	}

	session, err := s.sessionStore.GetByToken(cookie.Value)
	if err != nil {
		return nil, err
	}

	return s.userStore.GetByID(session.UserID)
}
