package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel/attribute"
)

// UserStore wraps userStore with OpenTelemetry span instrumentation.
type UserStore struct {
	inner *userStore
	instr instrumentation
}

// NewUserStore creates an instrumented UserStore.
func NewUserStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) *UserStore {
	return &UserStore{
		inner: newUserStore(db, d),
		instr: newInstrumentation(slowThreshold),
	}
}

func (s *UserStore) Create(ctx context.Context, username, password string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, username, password)
}

func (s *UserStore) GetByUsername(ctx context.Context, username string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.GetByUsername", &err)
	defer end()
	return s.inner.GetByUsername(ctx, username)
}

func (s *UserStore) GetByID(ctx context.Context, id string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.GetByID", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.GetByID(ctx, id)
}

func (s *UserStore) GetAll(ctx context.Context) (_ []*User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.GetAll", &err)
	defer end()
	return s.inner.GetAll(ctx)
}

func (s *UserStore) Search(ctx context.Context, term, excludeUserID string, limit int) (_ []*User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.Search", &err)
	defer end()
	return s.inner.Search(ctx, term, excludeUserID, limit)
}

func (s *UserStore) UpdateProfileIcon(ctx context.Context, id string, data []byte, contentType string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.UpdateProfileIcon", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.UpdateProfileIcon(ctx, id, data, contentType)
}

func (s *UserStore) GetProfileIcon(ctx context.Context, id string) (_ []byte, _ string, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.GetProfileIcon", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.GetProfileIcon(ctx, id)
}

func (s *UserStore) DeleteProfileIcon(ctx context.Context, id string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.DeleteProfileIcon", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.DeleteProfileIcon(ctx, id)
}

func (s *UserStore) UpdatePassword(ctx context.Context, id, newPassword string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.UpdatePassword", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.UpdatePassword(ctx, id, newPassword)
}

func (s *UserStore) UpdateProfile(ctx context.Context, id, username, firstName, lastName string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.UpdateProfile", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.UpdateProfile(ctx, id, username, firstName, lastName)
}

func (s *UserStore) UpdateRole(ctx context.Context, id, role string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.UpdateRole", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.UpdateRole(ctx, id, role)
}

func (s *UserStore) DeleteWithCleanup(ctx context.Context, id, requestingUserID string, preDelete, postDelete func(ctx context.Context, tx *sql.Tx) error) (err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.DeleteWithCleanup", &err,
		attribute.String("user.id", id),
	)
	defer end()
	return s.inner.DeleteWithCleanup(ctx, id, requestingUserID, preDelete, postDelete)
}

func (s *UserStore) CreateByAdmin(ctx context.Context, username, password string, role string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.CreateByAdmin", &err)
	defer end()
	return s.inner.CreateByAdmin(ctx, username, password, role)
}

func (s *UserStore) GetByOIDCIdentity(ctx context.Context, issuer, subject string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.GetByOIDCIdentity", &err)
	defer end()
	return s.inner.GetByOIDCIdentity(ctx, issuer, subject)
}

func (s *UserStore) ProvisionSSOUser(ctx context.Context, issuer, subject, usernameSeed string, grantAdminIfFirst bool) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.ProvisionSSOUser", &err)
	defer end()
	return s.inner.ProvisionSSOUser(ctx, issuer, subject, usernameSeed, grantAdminIfFirst)
}

func (s *UserStore) LinkOIDCIdentity(ctx context.Context, userID, issuer, subject string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.LinkOIDCIdentity", &err,
		attribute.String("user.id", userID),
	)
	defer end()
	return s.inner.LinkOIDCIdentity(ctx, userID, issuer, subject)
}

func (s *UserStore) UnlinkOIDCIdentity(ctx context.Context, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "UserStore.UnlinkOIDCIdentity", &err,
		attribute.String("user.id", userID),
	)
	defer end()
	return s.inner.UnlinkOIDCIdentity(ctx, userID)
}
