package models

import (
	"context"
	"database/sql"
)

func (s *NoteStore) GetNoteShares(ctx context.Context, noteID string) (_ []NoteShare, err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.GetNoteShares", &err)
	defer end()
	return s.inner.GetNoteShares(ctx, noteID)
}

func (s *NoteStore) ShareNote(ctx context.Context, noteID string, sharedByUserID, sharedWithUserID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.ShareNote", &err)
	defer end()
	return s.inner.ShareNote(ctx, noteID, sharedByUserID, sharedWithUserID)
}

func (s *NoteStore) UnshareNote(ctx context.Context, noteID string, sharedWithUserID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.UnshareNote", &err)
	defer end()
	return s.inner.UnshareNote(ctx, noteID, sharedWithUserID)
}

func (s *NoteStore) ClearUserAssignmentsTx(ctx context.Context, tx *sql.Tx, userID string) (err error) {
	ctx, end := startSpan(ctx, s.tracer, "NoteStore.ClearUserAssignmentsTx", &err)
	defer end()
	return s.inner.ClearUserAssignmentsTx(ctx, tx, userID)
}
