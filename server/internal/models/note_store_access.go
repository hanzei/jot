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
	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(rawQuery), queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to query note audiences: %w", err)
	}
	defer func() { _ = rows.Close() }()

	audiences := make(map[string][]string, len(noteIDs))
	for rows.Next() {
		var noteID string
		var audienceID string
		if err = rows.Scan(&noteID, &audienceID); err != nil {
			return nil, fmt.Errorf("failed to scan note audience: %w", err)
		}
		audiences[noteID] = append(audiences[noteID], audienceID)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("failed while reading note audiences: %w", err)
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
// delete changes for somebody else, each with the users who should hear of
// it. Every audience still includes the user being deleted; the caller drops
// them before publishing.
type UserNoteAudiences struct {
	// Owned are the user's own notes, which the delete removes.
	Owned []DeletedNoteAudience
	// SharedWith are other users' notes shared with the user. The delete
	// removes the user's share (and with it any assignment to them, or every
	// assignment on a note left with no shares), so the rest of the audience
	// must refetch the note.
	SharedWith []DeletedNoteAudience
}

// GetUserNoteAudiencesTx reads [UserNoteAudiences] for userID. It must run in
// the user delete's transaction, before the delete: afterwards the cascade has
// removed the notes and shares that identify the audiences.
//
// Collaborators are counted only for notes outside the trash: trashing a note
// already sent them note_deleted, so a trashed note's audience is its owner
// alone.
func (s *noteStore) GetUserNoteAudiencesTx(ctx context.Context, tx *sql.Tx, userID string) (*UserNoteAudiences, error) {
	owned, err := s.ownedNoteAudiencesTx(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	sharedWith, err := s.queryNoteAudiencesTx(ctx, tx,
		`SELECT n.id, n.user_id FROM notes n
		   JOIN note_shares me ON me.note_id = n.id
		  WHERE me.shared_with_user_id = ?
		 UNION
		 SELECT ns.note_id, ns.shared_with_user_id FROM note_shares ns
		   JOIN note_shares me ON me.note_id = ns.note_id
		   JOIN notes n ON n.id = ns.note_id
		  WHERE me.shared_with_user_id = ? AND n.deleted_at IS NULL
		 ORDER BY 1, 2`,
		userID, userID)
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
		  WHERE n.user_id = ? AND n.deleted_at IS NULL
		 ORDER BY 1, 2`,
		userID, userID)
	if err != nil {
		return nil, fmt.Errorf("get audiences of owned notes: %w", err)
	}
	return owned, nil
}

// queryNoteAudiencesTx runs a query yielding (note_id, user_id) rows ordered
// by note_id and groups them into one [DeletedNoteAudience] per note.
func (s *noteStore) queryNoteAudiencesTx(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]DeletedNoteAudience, error) {
	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(query), args...)
	if err != nil {
		return nil, err
	}
	type pair struct{ noteID, userID string }
	pairs, err := collectRows(rows, func(rows *sql.Rows) (pair, error) {
		var p pair
		return p, rows.Scan(&p.noteID, &p.userID)
	})
	if err != nil {
		return nil, err
	}
	audiences := []DeletedNoteAudience{}
	for _, p := range pairs {
		if n := len(audiences); n > 0 && audiences[n-1].NoteID == p.noteID {
			audiences[n-1].AudienceIDs = append(audiences[n-1].AudienceIDs, p.userID)
			continue
		}
		audiences = append(audiences, DeletedNoteAudience{NoteID: p.noteID, AudienceIDs: []string{p.userID}})
	}
	return audiences, nil
}
