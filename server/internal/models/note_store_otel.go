package models

import (
	"context"
	"database/sql"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"go.opentelemetry.io/otel/attribute"
)

// NoteStore wraps noteStore with OpenTelemetry span instrumentation.
type NoteStore struct {
	inner *noteStore
	instr instrumentation
}

// NewNoteStore creates an instrumented NoteStore.
func NewNoteStore(db *sql.DB, d *dialect.Dialect, slowThreshold time.Duration) *NoteStore {
	return &NoteStore{
		inner: newNoteStore(db, d),
		instr: newInstrumentation(slowThreshold),
	}
}

func (s *NoteStore) Create(ctx context.Context, userID string, n NewNote) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.Create", &err)
	defer end()
	return s.inner.Create(ctx, userID, n)
}

func (s *NoteStore) CreateWithItems(ctx context.Context, userID string, n NewNote, items []NewNoteItem) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.CreateWithItems", &err)
	defer end()
	return s.inner.CreateWithItems(ctx, userID, n, items)
}

func (s *NoteStore) Duplicate(ctx context.Context, source *Note, userID, clientID string, itemIDs map[string]string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.Duplicate", &err)
	defer end()
	return s.inner.Duplicate(ctx, source, userID, clientID, itemIDs)
}

func (s *NoteStore) GetByUserID(ctx context.Context, userID string, f NoteFilter) (_ []*Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetByUserID", &err)
	defer end()
	return s.inner.GetByUserID(ctx, userID, f)
}

func (s *NoteStore) GetByID(ctx context.Context, id string, userID string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetByID", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.GetByID(ctx, id, userID)
}

func (s *NoteStore) GetByIDAnyState(ctx context.Context, id string, userID string) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetByIDAnyState", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.GetByIDAnyState(ctx, id, userID)
}

func (s *NoteStore) Update(ctx context.Context, id string, userID string, u NoteUpdate) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.Update", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.Update(ctx, id, userID, u)
}

func (s *NoteStore) ConvertType(ctx context.Context, id, userID string, targetType NoteType, title, content string, targetItems []NewNoteItem, baseVersion *int) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ConvertType", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.ConvertType(ctx, id, userID, targetType, title, content, targetItems, baseVersion)
}

func (s *NoteStore) MoveToTrash(ctx context.Context, id string, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.MoveToTrash", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.MoveToTrash(ctx, id, userID)
}

func (s *NoteStore) RestoreFromTrash(ctx context.Context, id string, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.RestoreFromTrash", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.RestoreFromTrash(ctx, id, userID)
}

func (s *NoteStore) DeleteFromTrash(ctx context.Context, id string, userID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.DeleteFromTrash", &err,
		attribute.String("note.id", id),
	)
	defer end()
	return s.inner.DeleteFromTrash(ctx, id, userID)
}

func (s *NoteStore) EmptyTrash(ctx context.Context, userID string) (_ []DeletedNoteAudience, _ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.EmptyTrash", &err)
	defer end()
	return s.inner.EmptyTrash(ctx, userID)
}

func (s *NoteStore) DeleteAllByUser(ctx context.Context, userID string) (_ int, _ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.DeleteAllByUser", &err)
	defer end()
	return s.inner.DeleteAllByUser(ctx, userID)
}

func (s *NoteStore) PurgeOldTrashedNotes(ctx context.Context, olderThan time.Duration) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.PurgeOldTrashedNotes", &err)
	defer end()
	return s.inner.PurgeOldTrashedNotes(ctx, olderThan)
}

func (s *NoteStore) CreateItemWithCompleted(ctx context.Context, noteID, actorID, text string, position int, completed bool, parentID string, assignedTo string) (_ *NoteItem, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.CreateItemWithCompleted", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.CreateItemWithCompleted(ctx, noteID, actorID, text, position, completed, parentID, assignedTo)
}

func (s *NoteStore) CreateItemWithID(ctx context.Context, noteID, actorID, itemID, text string, position int, completed bool, parentID string, assignedTo string, maxItems int) (_ *NoteItem, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.CreateItemWithID", &err,
		attribute.String("note.id", noteID),
		attribute.String("item.id", itemID),
	)
	defer end()
	return s.inner.CreateItemWithID(ctx, noteID, actorID, itemID, text, position, completed, parentID, assignedTo, maxItems)
}

func (s *NoteStore) PatchItem(ctx context.Context, noteID, actorID, itemID string, patch NoteItemPatch) (_ *NoteItem, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.PatchItem", &err,
		attribute.String("note.id", noteID),
		attribute.String("item.id", itemID),
	)
	defer end()
	return s.inner.PatchItem(ctx, noteID, actorID, itemID, patch)
}

func (s *NoteStore) DeleteItemFromNote(ctx context.Context, noteID, actorID, itemID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.DeleteItemFromNote", &err,
		attribute.String("note.id", noteID),
		attribute.String("item.id", itemID),
	)
	defer end()
	return s.inner.DeleteItemFromNote(ctx, noteID, actorID, itemID)
}

func (s *NoteStore) ReorderItems(ctx context.Context, noteID, actorID string, itemIDs []string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ReorderItems", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.ReorderItems(ctx, noteID, actorID, itemIDs)
}

func (s *NoteStore) ToggleItemCompleted(ctx context.Context, noteID, actorID, itemID string, completed bool) (_ []NoteItem, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ToggleItemCompleted", &err,
		attribute.String("note.id", noteID),
		attribute.String("item.id", itemID),
	)
	defer end()
	return s.inner.ToggleItemCompleted(ctx, noteID, actorID, itemID, completed)
}

func (s *NoteStore) SetItemsCompleted(ctx context.Context, noteID, actorID string, itemIDs []string, completed bool) (_ []NoteItem, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.SetItemsCompleted", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.SetItemsCompleted(ctx, noteID, actorID, itemIDs, completed)
}

func (s *NoteStore) DeleteItems(ctx context.Context, noteID, actorID string, itemIDs []string) (_ []NoteItem, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.DeleteItems", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.DeleteItems(ctx, noteID, actorID, itemIDs)
}

func (s *NoteStore) HasAccess(ctx context.Context, noteID string, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.HasAccess", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.HasAccess(ctx, noteID, userID)
}

func (s *NoteStore) IsOwner(ctx context.Context, noteID string, userID string) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.IsOwner", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.IsOwner(ctx, noteID, userID)
}

func (s *NoteStore) GetOwnerID(ctx context.Context, noteID string) (_ string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetOwnerID", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetOwnerID(ctx, noteID)
}

func (s *NoteStore) ReorderNotes(ctx context.Context, userID string, noteIDs []string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ReorderNotes", &err)
	defer end()
	return s.inner.ReorderNotes(ctx, userID, noteIDs)
}

func (s *NoteStore) GetCollaboratorIDs(ctx context.Context, userID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetCollaboratorIDs", &err)
	defer end()
	return s.inner.GetCollaboratorIDs(ctx, userID)
}

func (s *NoteStore) GetNoteAudienceIDs(ctx context.Context, noteID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteAudienceIDs", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteAudienceIDs(ctx, noteID)
}

func (s *NoteStore) GetNoteLabels(ctx context.Context, noteID string, userID string) (_ []Label, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteLabels", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteLabels(ctx, noteID, userID)
}

func (s *NoteStore) AddLabelToNote(ctx context.Context, noteID, labelID, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.AddLabelToNote", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.AddLabelToNote(ctx, noteID, labelID, userID)
}

func (s *NoteStore) RemoveLabelFromNote(ctx context.Context, noteID, labelID, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.RemoveLabelFromNote", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.RemoveLabelFromNote(ctx, noteID, labelID, userID)
}

func (s *NoteStore) GetNoteShares(ctx context.Context, noteID string) (_ []NoteShare, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteShares", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteShares(ctx, noteID)
}

func (s *NoteStore) ShareNote(ctx context.Context, noteID string, sharedByUserID, sharedWithUserID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ShareNote", &err,
		attribute.String("note.id", noteID),
		attribute.String("shared_with.user.id", sharedWithUserID),
	)
	defer end()
	return s.inner.ShareNote(ctx, noteID, sharedByUserID, sharedWithUserID)
}

func (s *NoteStore) UnshareNote(ctx context.Context, noteID string, sharedWithUserID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.UnshareNote", &err,
		attribute.String("note.id", noteID),
		attribute.String("shared_with.user.id", sharedWithUserID),
	)
	defer end()
	return s.inner.UnshareNote(ctx, noteID, sharedWithUserID)
}

func (s *NoteStore) ClearUserAssignmentsTx(ctx context.Context, tx *sql.Tx, userID string) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ClearUserAssignmentsTx", &err)
	defer end()
	return s.inner.ClearUserAssignmentsTx(ctx, tx, userID)
}

func (s *NoteStore) MarkViewed(ctx context.Context, noteID, userID string, viewedAt time.Time) (_ bool, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.MarkViewed", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.MarkViewed(ctx, noteID, userID, viewedAt)
}

func (s *NoteStore) CreateNoteImage(ctx context.Context, noteID, uploaderID, filename, contentType string, sizeBytes int64, sha256 string, width, height, maxImages int) (_ *NoteImage, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.CreateNoteImage", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.CreateNoteImage(ctx, noteID, uploaderID, filename, contentType, sizeBytes, sha256, width, height, maxImages)
}

func (s *NoteStore) GetNoteImageByID(ctx context.Context, imageID string) (_ *NoteImage, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteImageByID", &err,
		attribute.String("image.id", imageID),
	)
	defer end()
	return s.inner.GetNoteImageByID(ctx, imageID)
}

func (s *NoteStore) GetNoteImagesByNoteID(ctx context.Context, noteID string) (_ []NoteImage, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteImagesByNoteID", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteImagesByNoteID(ctx, noteID)
}

func (s *NoteStore) GetNoteImageCountByNoteID(ctx context.Context, noteID string) (_ int, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteImageCountByNoteID", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetNoteImageCountByNoteID(ctx, noteID)
}

func (s *NoteStore) DeleteNoteImage(ctx context.Context, imageID, userID string) (_ *NoteImage, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.DeleteNoteImage", &err,
		attribute.String("image.id", imageID),
	)
	defer end()
	return s.inner.DeleteNoteImage(ctx, imageID, userID)
}

func (s *NoteStore) GetNoteImageRefCount(ctx context.Context, sha256 string) (_ int, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteImageRefCount", &err)
	defer end()
	return s.inner.GetNoteImageRefCount(ctx, sha256)
}

func (s *NoteStore) GetNoteImageRefCounts(ctx context.Context) (_ map[string]int, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteImageRefCounts", &err)
	defer end()
	return s.inner.GetNoteImageRefCounts(ctx)
}

func (s *NoteStore) GetNoteImageSHA256sForUserTx(ctx context.Context, tx *sql.Tx, userID string) (_ []string, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetNoteImageSHA256sForUserTx", &err)
	defer end()
	return s.inner.GetNoteImageSHA256sForUserTx(ctx, tx, userID)
}

func (s *NoteStore) GetOwnedNotesForExport(ctx context.Context, userID string) (_ []*Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetOwnedNotesForExport", &err)
	defer end()
	return s.inner.GetOwnedNotesForExport(ctx, userID)
}

func (s *NoteStore) ImportJotNotes(ctx context.Context, userID string, notes []JotImportNote) (err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ImportJotNotes", &err)
	defer end()
	return s.inner.ImportJotNotes(ctx, userID, notes)
}

func (s *NoteStore) ListRevisions(ctx context.Context, noteID, userID string) (_ []NoteRevisionSummary, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.ListRevisions", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.ListRevisions(ctx, noteID, userID)
}

func (s *NoteStore) GetRevision(ctx context.Context, noteID, revisionID, userID string) (_ *NoteRevision, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.GetRevision", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.GetRevision(ctx, noteID, revisionID, userID)
}

func (s *NoteStore) RestoreRevision(ctx context.Context, noteID, revisionID, userID string, baseVersion *int) (_ *Note, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.RestoreRevision", &err,
		attribute.String("note.id", noteID),
	)
	defer end()
	return s.inner.RestoreRevision(ctx, noteID, revisionID, userID, baseVersion)
}

func (s *NoteStore) PruneRevisions(ctx context.Context) (_ int64, err error) {
	ctx, end := startSpan(ctx, s.instr, "NoteStore.PruneRevisions", &err)
	defer end()
	return s.inner.PruneRevisions(ctx)
}
