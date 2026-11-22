package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

func (s *noteStore) getNoteAudiencesTx(ctx context.Context, tx *sql.Tx, noteIDs []string) (map[string][]string, error) {
	if len(noteIDs) == 0 {
		return map[string][]string{}, nil
	}

	placeholders, args := buildInClauseArgs(noteIDs)
	queryArgs := make([]any, 0, len(args)*2)
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, args...)

	rawQuery := `SELECT id AS note_id, user_id FROM notes WHERE id IN (` + placeholders + `)
		 UNION
		 SELECT note_id, shared_with_user_id FROM note_shares WHERE note_id IN (` + placeholders + `)` // #nosec G202 -- only generated "?" placeholders are concatenated
	list, err := s.queryNoteAudiencesTx(ctx, tx, rawQuery, queryArgs...)
	if err != nil {
		return nil, err
	}
	audiences := make(map[string][]string, len(list))
	for _, note := range list {
		audiences[note.NoteID] = note.AudienceIDs
	}
	return audiences, nil
}

func (s *noteStore) HasAccess(ctx context.Context, noteID string, userID string) (bool, error) {
	// Use the same predicate as GetByID: a note_user_state row exists for both
	// owners and collaborators, so this is a single consistent access check.
	var count int
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_user_state nus
		 INNER JOIN active_notes n ON n.id = nus.note_id
		 WHERE nus.note_id = ? AND nus.user_id = ?`),
		noteID, userID,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check access: %w", err)
	}
	return count > 0, nil
}

func (s *noteStore) IsOwner(ctx context.Context, noteID string, userID string) (bool, error) {
	var count int
	query := s.d.RewritePlaceholders(`SELECT COUNT(*) FROM notes WHERE id = ? AND user_id = ?`)

	err := s.db.QueryRowContext(ctx, query, noteID, userID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check ownership: %w", err)
	}

	return count > 0, nil
}

// GetOwnerID returns the owner user ID for a note.
func (s *noteStore) GetOwnerID(ctx context.Context, noteID string) (string, error) {
	var ownerID string
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT user_id FROM notes WHERE id = ?`), noteID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNoteNotFound
		}
		return "", fmt.Errorf("failed to get note owner: %w", err)
	}
	return ownerID, nil
}

// GetCollaboratorIDs returns the IDs of all users who share at least one note
// with userID (in either direction). Used to determine who to notify when a
// user's profile icon changes.
func (s *noteStore) GetCollaboratorIDs(ctx context.Context, userID string) ([]string, error) {
	query := s.d.RewritePlaceholders(`
		SELECT DISTINCT shared_with_user_id FROM note_shares WHERE shared_by_user_id = ?
		UNION
		SELECT DISTINCT shared_by_user_id FROM note_shares WHERE shared_with_user_id = ?
	`)
	rows, err := s.db.QueryContext(ctx, query, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get collaborator IDs: %w", err)
	}

	scanString := func(rows *sql.Rows) (string, error) {
		var v string
		return v, rows.Scan(&v)
	}
	ids, err := collectRows(rows, scanString)
	if err != nil {
		return nil, fmt.Errorf("failed to scan collaborator IDs: %w", err)
	}
	return ids, nil
}

// GetNoteAudienceIDs returns the owner's user ID plus all shared_with user IDs for a note.
// Used by handlers to determine who to broadcast SSE events to.
func (s *noteStore) GetNoteAudienceIDs(ctx context.Context, noteID string) ([]string, error) {
	query := s.d.RewritePlaceholders(`
		SELECT user_id FROM notes WHERE id = ?
		UNION
		SELECT shared_with_user_id FROM note_shares WHERE note_id = ?
	`)
	rows, err := s.db.QueryContext(ctx, query, noteID, noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note audience: %w", err)
	}

	scanString := func(rows *sql.Rows) (string, error) {
		var v string
		return v, rows.Scan(&v)
	}
	ids, err := collectRows(rows, scanString)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note audience: %w", err)
	}
	return ids, nil
}

// UserNoteAudiences lists, for a user about to be hard-deleted, the notes the
// delete changes for somebody else, each with the users who should hear of it.
type UserNoteAudiences struct {
	// Owned are the user's own notes, which the delete removes. Each
	// audience includes the user.
	Owned []DeletedNoteAudience
	// SharedWith are other users' notes outside the trash that the delete
	// changes but keeps: those shared with the user, or holding an image
	// they uploaded (a former collaborator's uploads stay after the
	// unshare). The audiences exclude the user.
	SharedWith []DeletedNoteAudience
}

// GetUserNoteAudiencesTx reads [UserNoteAudiences] for userID. It must run in
// the user delete's transaction, before the delete: afterwards the cascade has
// removed the notes and shares that identify the audiences.
//
// Trashing a note already sent its collaborators note_deleted, so an owned
// note in the trash has its owner alone as audience, and SharedWith leaves
// out trashed notes entirely: their owner can't fetch them to refresh.
func (s *noteStore) GetUserNoteAudiencesTx(ctx context.Context, tx *sql.Tx, userID string) (*UserNoteAudiences, error) {
	owned, err := s.ownedNoteAudiencesTx(ctx, tx, userID)
	if err != nil {
		return nil, fmt.Errorf("read owned notes: %w", err)
	}
	sharedWith, err := s.queryNoteAudiencesTx(ctx, tx,
		`WITH affected AS (
		   SELECT note_id FROM note_shares WHERE shared_with_user_id = ?
		   UNION
		   SELECT ni.note_id FROM note_images ni
		     JOIN notes n ON n.id = ni.note_id
		    WHERE ni.uploader_id = ? AND n.user_id <> ?
		 )
		 SELECT n.id, n.user_id FROM notes n
		   JOIN affected a ON a.note_id = n.id
		  WHERE n.deleted_at IS NULL
		 UNION
		 SELECT ns.note_id, ns.shared_with_user_id FROM note_shares ns
		   JOIN affected a ON a.note_id = ns.note_id
		   JOIN notes n ON n.id = ns.note_id
		  WHERE n.deleted_at IS NULL AND ns.shared_with_user_id <> ?`,
		userID, userID, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("get audiences of notes shared with user: %w", err)
	}
	return &UserNoteAudiences{Owned: owned, SharedWith: sharedWith}, nil
}

// ownedNoteAudiencesTx returns every note userID owns, in any state, with its
// audience: the owner, plus the collaborators of a note outside the trash.
func (s *noteStore) ownedNoteAudiencesTx(ctx context.Context, tx *sql.Tx, userID string) ([]DeletedNoteAudience, error) {
	owned, err := s.queryNoteAudiencesTx(ctx, tx,
		`SELECT id, user_id FROM notes WHERE user_id = ?
		 UNION
		 SELECT ns.note_id, ns.shared_with_user_id FROM note_shares ns
		   JOIN notes n ON n.id = ns.note_id
		  WHERE n.user_id = ? AND n.deleted_at IS NULL`,
		userID, userID)
	if err != nil {
		return nil, fmt.Errorf("get audiences of owned notes: %w", err)
	}
	return owned, nil
}

// queryNoteAudiencesTx runs a query yielding (note_id, user_id) rows and
// groups them into one [DeletedNoteAudience] per note, in order of first
// appearance.
func (s *noteStore) queryNoteAudiencesTx(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]DeletedNoteAudience, error) {
	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(query), args...)
	if err != nil {
		return nil, fmt.Errorf("query note audiences: %w", err)
	}
	type pair struct{ noteID, userID string }
	pairs, err := collectRows(rows, func(rows *sql.Rows) (pair, error) {
		var p pair
		return p, rows.Scan(&p.noteID, &p.userID)
	})
	if err != nil {
		return nil, fmt.Errorf("scan note audiences: %w", err)
	}
	audiences := []DeletedNoteAudience{}
	index := make(map[string]int)
	for _, p := range pairs {
		i, ok := index[p.noteID]
		if !ok {
			i = len(audiences)
			index[p.noteID] = i
			audiences = append(audiences, DeletedNoteAudience{NoteID: p.noteID})
		}
		audiences[i].AudienceIDs = append(audiences[i].AudienceIDs, p.userID)
	}
	return audiences, nil
}
