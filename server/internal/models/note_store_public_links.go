package models

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// PublicLink is a note's public read-only link (#1135). At most one exists per
// note; it is shared by the owner and every collaborator. Only Token is needed
// to build the URL — clients do that with publicNoteUrl in @jot/shared.
type PublicLink struct {
	Token string `json:"token"`
	// CreatedBy is the user who created the link, or null once that user has
	// been deleted.
	CreatedBy *string   `json:"created_by" extensions:"x-nullable"`
	CreatedAt time.Time `json:"created_at"`
	// ExpiresAt is null for a link that never expires.
	ExpiresAt *time.Time `json:"expires_at" extensions:"x-nullable"`
}

// PublicNote is the reduced, unauthenticated view of a note served through its
// public link. It deliberately carries nothing about who owns or shares the
// note: no collaborators, labels, color, owner, or creator.
type PublicNote struct {
	NoteType NoteType `json:"note_type" enums:"text,list"`
	// Title is always empty for a text note.
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updated_at"`
	// ImageIDs lists the note's images in upload order; fetch each through
	// /public/notes/{token}/images/{id} (or .../thumbnail).
	ImageIDs []string `json:"image_ids"`
	// Content is present for text notes only.
	Content *string `json:"content,omitzero"`
	// Items is present for list notes only.
	Items []PublicNoteItem `json:"items,omitzero"`
	// CheckedItemsCollapsed is present for list notes only: whether the owner
	// keeps the completed-items section collapsed.
	CheckedItemsCollapsed *bool `json:"checked_items_collapsed,omitzero"`
}

// PublicNoteItem is a list item as served through a public link. ID is only
// there so ParentID can refer to another item.
type PublicNoteItem struct {
	ID        string  `json:"id"`
	Text      string  `json:"text"`
	Completed bool    `json:"completed"`
	ParentID  *string `json:"parent_id" extensions:"x-nullable"`
	Position  int     `json:"position"`
}

// ErrPublicLinkNotFound is returned for every token that does not resolve to a
// visible note: unknown, malformed, revoked, expired, or pointing at a trashed
// note. Callers map it to one uniform 404 so a visitor cannot tell which.
var ErrPublicLinkNotFound = errors.New("public link not found")

// publicLinkTokenBytes is the token's entropy: the same as session and
// personal access tokens.
const publicLinkTokenBytes = 32

// publicLinkTokenRe is the shape of a token: 32 bytes as unpadded base64url.
var publicLinkTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// IsValidPublicLinkToken reports whether token has the shape of a public link
// token, so a malformed one can be rejected without a database lookup.
func IsValidPublicLinkToken(token string) bool {
	return publicLinkTokenRe.MatchString(token)
}

func generatePublicLinkToken() (string, error) {
	b := make([]byte, publicLinkTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// activePublicLinkCond restricts note_public_links (aliased l) to links that
// have not expired; it takes the current Timestamp as its one argument.
const activePublicLinkCond = `(l.expires_at IS NULL OR l.expires_at > ?)`

func scanPublicLink(rows *sql.Rows) (string, PublicLink, error) {
	var noteID string
	var link PublicLink
	err := rows.Scan(&noteID, &link.Token, &link.CreatedBy, &link.CreatedAt, &link.ExpiresAt)
	return noteID, link, err
}

// SetPublicLink sets the state of noteID's public link and returns it:
//   - no link, or only an expired one: a new link with a fresh token is
//     created. An expired link is never revived.
//   - an active link: only its expiry changes; token, creator and creation
//     time stay, so the URL keeps working.
//
// Repeating the call is therefore idempotent, and two concurrent calls end up
// with the same link rather than one replacing the other's. The caller checks
// that userID may manage the note's link.
func (s *noteStore) SetPublicLink(ctx context.Context, noteID, userID string, expiresAt *time.Time) (*PublicLink, error) {
	id, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("generate public link ID: %w", err)
	}
	token, err := generatePublicLinkToken()
	if err != nil {
		return nil, fmt.Errorf("generate public link token: %w", err)
	}
	var expires any
	if expiresAt != nil {
		expires = Timestamp(*expiresAt)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := Timestamp(Now())

	if _, err = tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_public_links
		 WHERE note_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`),
		noteID, now,
	); err != nil {
		return nil, fmt.Errorf("failed to delete expired public link: %w", err)
	}

	// The unique index on note_id turns a second insert for the same note,
	// including a concurrent one, into a no-op; the update below then applies
	// this call's expiry to whichever link won.
	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(s.d.InsertIgnore("note_public_links", "id, note_id, token, created_by, created_at, expires_at", "?, ?, ?, ?, ?, ?")),
		id, noteID, token, userID, now, expires,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create public link: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("failed to get rows affected: %w", err)
	}
	if inserted == 0 {
		if _, err = tx.ExecContext(ctx,
			s.d.RewritePlaceholders(`UPDATE note_public_links SET expires_at = ? WHERE note_id = ?`),
			expires, noteID,
		); err != nil {
			return nil, fmt.Errorf("failed to update public link expiry: %w", err)
		}
	}

	var link PublicLink
	if err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT token, created_by, created_at, expires_at FROM note_public_links WHERE note_id = ?`),
		noteID,
	).Scan(&link.Token, &link.CreatedBy, &link.CreatedAt, &link.ExpiresAt); err != nil {
		return nil, fmt.Errorf("failed to read public link: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit public link: %w", err)
	}
	return &link, nil
}

// DeletePublicLink revokes noteID's public link by deleting its row. It
// reports whether there was one; revoking a note without a link is not an
// error.
func (s *noteStore) DeletePublicLink(ctx context.Context, noteID string) (bool, error) {
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_public_links WHERE note_id = ?`), noteID)
	if err != nil {
		return false, fmt.Errorf("failed to delete public link: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to get rows affected: %w", err)
	}
	return n > 0, nil
}

// getPublicLinksByNoteIDs returns the active (unexpired) public link of each
// note in noteIDs that has one, keyed by note ID.
func (s *noteStore) getPublicLinksByNoteIDs(ctx context.Context, noteIDs []string) (map[string]*PublicLink, error) {
	result := map[string]*PublicLink{}
	now := Timestamp(Now())

	for chunk := range slices.Chunk(noteIDs, noteIDsQueryBatchSize) {
		placeholders := strings.Join(slices.Repeat([]string{"?"}, len(chunk)), ",")
		args := make([]any, 0, len(chunk)+1)
		for _, id := range chunk {
			args = append(args, id)
		}
		args = append(args, now)

		query := `SELECT l.note_id, l.token, l.created_by, l.created_at, l.expires_at
				  FROM note_public_links l
				  WHERE l.note_id IN (` + placeholders + `) AND ` + activePublicLinkCond // #nosec G202 -- only "?" placeholders are joined, no user input

		rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), args...)
		if err != nil {
			return nil, fmt.Errorf("failed to batch-get public links: %w", err)
		}
		for _, err := range scanRows(rows, func(rows *sql.Rows) (struct{}, error) {
			noteID, link, err := scanPublicLink(rows)
			if err == nil {
				result[noteID] = &link
			}
			return struct{}{}, err
		}) {
			if err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("failed to scan public link: %w", err)
			}
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("failed to close public links rows: %w", err)
		}
	}
	return result, nil
}

// publicNoteIDByToken resolves token to the ID of the note it publishes. Only
// an active link on an active (not trashed) note resolves; everything else is
// ErrPublicLinkNotFound. Archived notes stay visible.
func (s *noteStore) publicNoteIDByToken(ctx context.Context, token string) (string, error) {
	if !IsValidPublicLinkToken(token) {
		return "", ErrPublicLinkNotFound
	}
	var noteID string
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT n.id FROM note_public_links l
		 INNER JOIN active_notes n ON n.id = l.note_id
		 WHERE l.token = ? AND `+activePublicLinkCond),
		token, Timestamp(Now()),
	).Scan(&noteID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrPublicLinkNotFound
		}
		return "", fmt.Errorf("failed to resolve public link: %w", err)
	}
	return noteID, nil
}

// GetPublicNote returns the reduced view of the note token publishes, or
// ErrPublicLinkNotFound.
func (s *noteStore) GetPublicNote(ctx context.Context, token string) (*PublicNote, error) {
	noteID, err := s.publicNoteIDByToken(ctx, token)
	if err != nil {
		return nil, err
	}

	// checked_items_collapsed is per-user state; the owner's is the one the
	// public view mirrors.
	var note PublicNote
	var content string
	var collapsed bool
	err = s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT n.note_type, n.title, n.content, n.updated_at, nus.checked_items_collapsed
		 FROM active_notes n
		 INNER JOIN note_user_state nus ON nus.note_id = n.id AND nus.user_id = n.user_id
		 WHERE n.id = ?`),
		noteID,
	).Scan(&note.NoteType, &note.Title, &content, &note.UpdatedAt, &collapsed)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPublicLinkNotFound
		}
		return nil, fmt.Errorf("failed to get public note: %w", err)
	}

	if note.NoteType == NoteTypeList {
		items, itemsErr := s.getItemsByNoteID(ctx, noteID)
		if itemsErr != nil {
			return nil, fmt.Errorf("get public note items: %w", itemsErr)
		}
		note.Items = make([]PublicNoteItem, 0, len(items))
		for _, it := range items {
			note.Items = append(note.Items, PublicNoteItem{
				ID: it.ID, Text: it.Text, Completed: it.Completed, ParentID: it.ParentID, Position: it.Position,
			})
		}
		note.CheckedItemsCollapsed = &collapsed
	} else {
		// Mirrors SanitizeNote: a text note has no title.
		note.Title = ""
		note.Content = &content
	}

	images, err := s.GetNoteImagesByNoteID(ctx, noteID)
	if err != nil {
		return nil, fmt.Errorf("get public note images: %w", err)
	}
	note.ImageIDs = make([]string, 0, len(images))
	for _, img := range images {
		note.ImageIDs = append(note.ImageIDs, img.ID)
	}

	return &note, nil
}

// GetPublicNoteImage returns imageID when it belongs to the note token
// publishes. An image of any other note is ErrPublicLinkNotFound, the same as
// a dead link, so the public path never reaches beyond its one note.
func (s *noteStore) GetPublicNoteImage(ctx context.Context, token, imageID string) (*NoteImage, error) {
	noteID, err := s.publicNoteIDByToken(ctx, token)
	if err != nil {
		return nil, err
	}
	if !IsValidID(imageID) {
		return nil, ErrPublicLinkNotFound
	}
	img, err := s.GetNoteImageByID(ctx, imageID)
	if err != nil {
		if errors.Is(err, ErrNoteImageNotFound) {
			return nil, ErrPublicLinkNotFound
		}
		return nil, fmt.Errorf("get public note image: %w", err)
	}
	if img.NoteID != noteID {
		return nil, ErrPublicLinkNotFound
	}
	return img, nil
}
