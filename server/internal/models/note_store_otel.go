package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// NoteStore wraps noteStore with OpenTelemetry span instrumentation.
type NoteStore struct {
	inner  *noteStore
	tracer trace.Tracer
}

// NewNoteStore creates an instrumented NoteStore.
func NewNoteStore(db *sql.DB, d *dialect.Dialect) *NoteStore {
	return &NoteStore{
		inner:  newNoteStore(db, d),
		tracer: otel.Tracer("github.com/hanzei/jot/server"),
	}
}

func (s *NoteStore) Create(ctx context.Context, userID string, title, content string, noteType NoteType, color string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, userID, title, content, noteType, color)
}

func (s *NoteStore) Duplicate(ctx context.Context, source *Note, userID string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.Duplicate", &err)
	defer end()
	return s.inner.Duplicate(ctx, source, userID)
}

func (s *NoteStore) GetByUserID(ctx context.Context, userID string, archived bool, trashed bool, search string, labelID string, myTasks bool) (_ []*Note, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetByUserID", &err)
	defer end()
	return s.inner.GetByUserID(ctx, userID, archived, trashed, search, labelID, myTasks)
}

func (s *NoteStore) GetByID(ctx context.Context, id string, userID string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetByID", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.GetByID(ctx, id, userID)
}

func (s *NoteStore) GetByIDAnyState(ctx context.Context, id string, userID string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetByIDAnyState", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.GetByIDAnyState(ctx, id, userID)
}

func (s *NoteStore) Update(ctx context.Context, id string, userID string, title, content, color *string, pinned, archived, checkedItemsCollapsed *bool) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.Update", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.Update(ctx, id, userID, title, content, color, pinned, archived, checkedItemsCollapsed)
}

func (s *NoteStore) Delete(ctx context.Context, id string, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.Delete", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.Delete(ctx, id, userID)
}

func (s *NoteStore) MoveToTrash(ctx context.Context, id string, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.MoveToTrash", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.MoveToTrash(ctx, id, userID)
}

func (s *NoteStore) RestoreFromTrash(ctx context.Context, id string, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.RestoreFromTrash", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.RestoreFromTrash(ctx, id, userID)
}

func (s *NoteStore) DeleteFromTrash(ctx context.Context, id string, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.DeleteFromTrash", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.DeleteFromTrash(ctx, id, userID)
}

func (s *NoteStore) EmptyTrash(ctx context.Context, userID string) (_ []DeletedNoteAudience, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.EmptyTrash", &err)
	defer end()
	return s.inner.EmptyTrash(ctx, userID)
}

func (s *NoteStore) PurgeOldTrashedNotes(ctx context.Context, olderThan time.Duration) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.PurgeOldTrashedNotes", &err)
	defer end()
	return s.inner.PurgeOldTrashedNotes(ctx, olderThan)
}

func (s *NoteStore) CreateItem(ctx context.Context, noteID string, text string, position, indentLevel int, assignedTo string) (_ *NoteItem, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.CreateItem", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.CreateItem(ctx, noteID, text, position, indentLevel, assignedTo)
}

func (s *NoteStore) UpdateItem(ctx context.Context, id string, text string, completed bool, position, indentLevel int) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.UpdateItem", &err,
		attribute.String("item.id", id),
	)
	defer end()
	return s.inner.UpdateItem(ctx, id, text, completed, position, indentLevel)
}

func (s *NoteStore) DeleteItem(ctx context.Context, id string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.DeleteItem", &err,
		attribute.String("item.id", id),
	)
	defer end()
	return s.inner.DeleteItem(ctx, id)
}

func (s *NoteStore) DeleteItemsByNoteID(ctx context.Context, noteID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.DeleteItemsByNoteID", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.DeleteItemsByNoteID(ctx, noteID)
}

func (s *NoteStore) CreateItemWithCompleted(ctx context.Context, noteID string, text string, position int, completed bool, indentLevel int, assignedTo string) (_ *NoteItem, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.CreateItemWithCompleted", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.CreateItemWithCompleted(ctx, noteID, text, position, completed, indentLevel, assignedTo)
}

func (s *NoteStore) HasAccess(ctx context.Context, noteID string, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.HasAccess", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.HasAccess(ctx, noteID, userID)
}

func (s *NoteStore) IsOwner(ctx context.Context, noteID string, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.IsOwner", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.IsOwner(ctx, noteID, userID)
}

func (s *NoteStore) GetOwnerID(ctx context.Context, noteID string) (_ string, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetOwnerID", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetOwnerID(ctx, noteID)
}

func (s *NoteStore) ReorderNotes(ctx context.Context, userID string, noteIDs []string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.ReorderNotes", &err)
	defer end()
	return s.inner.ReorderNotes(ctx, userID, noteIDs)
}

func (s *NoteStore) GetCollaboratorIDs(ctx context.Context, userID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetCollaboratorIDs", &err)
	defer end()
	return s.inner.GetCollaboratorIDs(ctx, userID)
}

func (s *NoteStore) GetNoteAudienceIDs(ctx context.Context, noteID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetNoteAudienceIDs", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteAudienceIDs(ctx, noteID)
}

func (s *NoteStore) GetNoteLabels(ctx context.Context, noteID string, userID string) (_ []Label, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetNoteLabels", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteLabels(ctx, noteID, userID)
}

func (s *NoteStore) AddLabelToNote(ctx context.Context, noteID, labelID, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.AddLabelToNote", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.AddLabelToNote(ctx, noteID, labelID, userID)
}

func (s *NoteStore) RemoveLabelFromNote(ctx context.Context, noteID, labelID, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.RemoveLabelFromNote", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.RemoveLabelFromNote(ctx, noteID, labelID, userID)
}

func (s *NoteStore) GetOwnedNotesForExport(ctx context.Context, userID string) (_ []*Note, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetOwnedNotesForExport", &err)
	defer end()
	return s.inner.GetOwnedNotesForExport(ctx, userID)
}

func (s *NoteStore) ImportJotNotes(ctx context.Context, userID string, notes []JotImportNote) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.ImportJotNotes", &err)
	defer end()
	return s.inner.ImportJotNotes(ctx, userID, notes)
}
