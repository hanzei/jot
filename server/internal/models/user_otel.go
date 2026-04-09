package models

import (
	"context"
	"database/sql"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// UserStore wraps userStore with OpenTelemetry span instrumentation.
type UserStore struct {
	inner  *userStore
	tracer trace.Tracer
}

// NewUserStore creates an instrumented UserStore.
func NewUserStore(db *sql.DB) *UserStore {
	return &UserStore{
		inner:  newUserStore(db),
		tracer: otel.Tracer("github.com/hanzei/jot/server"),
	}
}

func (s *UserStore) Create(ctx context.Context, username, password string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, username, password)
}

func (s *UserStore) GetByUsername(ctx context.Context, username string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.GetByUsername", &err)
	defer end()
	return s.inner.GetByUsername(ctx, username)
}

func (s *UserStore) GetByID(ctx context.Context, id string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.GetByID", &err)
	defer end()
	return s.inner.GetByID(ctx, id)
}

func (s *UserStore) GetAll(ctx context.Context) (_ []*User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.GetAll", &err)
	defer end()
	return s.inner.GetAll(ctx)
}

func (s *UserStore) Search(ctx context.Context, term string) (_ []*User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.Search", &err)
	defer end()
	return s.inner.Search(ctx, term)
}

func (s *UserStore) UpdateUsername(ctx context.Context, id, newUsername string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.UpdateUsername", &err)
	defer end()
	return s.inner.UpdateUsername(ctx, id, newUsername)
}

func (s *UserStore) UpdateProfileIcon(ctx context.Context, id string, data []byte, contentType string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.UpdateProfileIcon", &err)
	defer end()
	return s.inner.UpdateProfileIcon(ctx, id, data, contentType)
}

func (s *UserStore) GetProfileIcon(ctx context.Context, id string) (_ []byte, _ string, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.GetProfileIcon", &err)
	defer end()
	return s.inner.GetProfileIcon(ctx, id)
}

func (s *UserStore) DeleteProfileIcon(ctx context.Context, id string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.DeleteProfileIcon", &err)
	defer end()
	return s.inner.DeleteProfileIcon(ctx, id)
}

func (s *UserStore) UpdatePassword(ctx context.Context, id, newPassword string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.UpdatePassword", &err)
	defer end()
	return s.inner.UpdatePassword(ctx, id, newPassword)
}

func (s *UserStore) UpdateName(ctx context.Context, id, firstName, lastName string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.UpdateName", &err)
	defer end()
	return s.inner.UpdateName(ctx, id, firstName, lastName)
}

func (s *UserStore) UpdateProfile(ctx context.Context, id, username, firstName, lastName string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.UpdateProfile", &err)
	defer end()
	return s.inner.UpdateProfile(ctx, id, username, firstName, lastName)
}

func (s *UserStore) UpdateRole(ctx context.Context, id, role string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.UpdateRole", &err)
	defer end()
	return s.inner.UpdateRole(ctx, id, role)
}

func (s *UserStore) Delete(ctx context.Context, id, requestingUserID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.Delete", &err)
	defer end()
	return s.inner.Delete(ctx, id, requestingUserID)
}

func (s *UserStore) DeleteWithCleanup(ctx context.Context, id, requestingUserID string, postDelete func(ctx context.Context, tx *sql.Tx) error) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.DeleteWithCleanup", &err)
	defer end()
	return s.inner.DeleteWithCleanup(ctx, id, requestingUserID, postDelete)
}

func (s *UserStore) CreateByAdmin(ctx context.Context, username, password string, role string) (_ *User, err error) {
	ctx, end := startSpan(ctx, s.tracer, "UserStore.CreateByAdmin", &err)
	defer end()
	return s.inner.CreateByAdmin(ctx, username, password, role)
}
