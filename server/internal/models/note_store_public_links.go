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
	// Images lists the note's images in upload order; fetch each through
	// /public/notes/{token}/images/{id} (or .../thumbnail).
	Images []PublicNoteImage `json:"images"`
	// Content is present for text notes only.
	Content *string `json:"content,omitzero"`
	// Items is present for list notes only.
	Items []PublicNoteItem `json:"items,omitzero"`
	// CheckedItemsCollapsed is present for list notes only: whether the owner
	// keeps the completed-items section collapsed.
	CheckedItemsCollapsed *bool `json:"checked_items_collapsed,omitzero"`
}

// PublicNoteImage is an image as served through a public link: only what the
// viewer needs to lay it out before it loads, none of NoteImage's filename,
// content type, or upload time.
type PublicNoteImage struct {
	ID     string `json:"id"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
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

// notePublicLink is a public link row together with the note it belongs to.
type notePublicLink struct {
	noteID string
	link   PublicLink
}

func scanNotePublicLink(rows *sql.Rows) (notePublicLink, error) {
	var r notePublicLink
	err := rows.Scan(&r.noteID, &r.link.Token, &r.link.CreatedBy, &r.link.CreatedAt, &r.link.ExpiresAt)
	return r, err
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
	// this call's expiry to whichever link won. The conflict target is named so
	// that only that index is absorbed: a clash on any other (the token) still
	// fails loudly. Both backends accept this upsert syntax.
	result, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_public_links (id, note_id, token, created_by, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (note_id) DO NOTHING`),
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
		placeholders, args := buildInClauseArgs(chunk)
		args = append(args, now)

		query := `SELECT l.note_id, l.token, l.created_by, l.created_at, l.expires_at
				  FROM note_public_links l
				  WHERE l.note_id IN (` + placeholders + `) AND ` + activePublicLinkCond // #nosec G202 -- only "?" placeholders are joined, no user input

		rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), args...)
		if err != nil {
			return nil, fmt.Errorf("failed to batch-get public links: %w", err)
		}
		links, err := collectRows(rows, scanNotePublicLink)
		if err != nil {
			return nil, fmt.Errorf("failed to scan public links: %w", err)
		}
		for _, l := range links {
			result[l.noteID] = &l.link
		}
	}
	return result, nil
}

// GetPublicNote returns the reduced view of the note token publishes. Only an
// active link on an active (not trashed) note resolves; everything else —
// including a malformed token, rejected before any query — is
// ErrPublicLinkNotFound. Archived notes stay visible.
func (s *noteStore) GetPublicNote(ctx context.Context, token string) (*PublicNote, error) {
	if !IsValidPublicLinkToken(token) {
		return nil, ErrPublicLinkNotFound
	}

	// checked_items_collapsed is per-user state; the owner's is the one the
	// public view mirrors.
	var noteID, content string
	var collapsed bool
	var note PublicNote
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT n.id, n.note_type, n.title, n.content, n.updated_at, nus.checked_items_collapsed
		 FROM note_public_links l
		 INNER JOIN active_notes n ON n.id = l.note_id
		 INNER JOIN note_user_state nus ON nus.note_id = n.id AND nus.user_id = n.user_id
		 WHERE l.token = ? AND `+activePublicLinkCond),
		token, Timestamp(Now()),
	).Scan(&noteID, &note.NoteType, &note.Title, &content, &note.UpdatedAt, &collapsed)
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
	note.Images = make([]PublicNoteImage, 0, len(images))
	for _, img := range images {
		note.Images = append(note.Images, PublicNoteImage{ID: img.ID, Width: img.Width, Height: img.Height})
	}

	return &note, nil
}

// GetPublicNoteImage returns imageID when it belongs to the note token
// publishes, under the same rules as GetPublicNote. An image of any other note
// is ErrPublicLinkNotFound, the same as a dead link, so the public path never
// reaches beyond its one note.
func (s *noteStore) GetPublicNoteImage(ctx context.Context, token, imageID string) (*NoteImage, error) {
	if !IsValidPublicLinkToken(token) || !IsValidID(imageID) {
		return nil, ErrPublicLinkNotFound
	}

	var img NoteImage
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT i.id, i.note_id, i.uploader_id, i.filename, i.content_type, i.size_bytes, i.sha256, i.width, i.height, i.created_at
		 FROM note_public_links l
		 INNER JOIN active_notes n ON n.id = l.note_id
		 INNER JOIN note_images i ON i.note_id = n.id
		 WHERE l.token = ? AND i.id = ? AND `+activePublicLinkCond),
		token, imageID, Timestamp(Now()),
	).Scan(
		&img.ID, &img.NoteID, &img.UploaderID, &img.Filename, &img.ContentType,
		&img.SizeBytes, &img.SHA256, &img.Width, &img.Height, &img.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPublicLinkNotFound
		}
		return nil, fmt.Errorf("failed to get public note image: %w", err)
	}
	return &img, nil
}

// PublicNotePreview is all of a public note that its link-preview card shows
// (#1209): the title and the first image. Never the note's text — a card
// outlives the link in chat histories.
type PublicNotePreview struct {
	// Title is always empty for a text note, as in PublicNote.
	Title string
	// FirstImage is the note's earliest image, or nil when it has none.
	FirstImage *PublicNoteImage
}

// GetPublicNotePreview returns the preview of the note token publishes, under
// the same rules as GetPublicNote (including its join on the owner's
// note_user_state): every dead token is ErrPublicLinkNotFound. One query, as
// it runs on every /share/{token} page load.
func (s *noteStore) GetPublicNotePreview(ctx context.Context, token string) (*PublicNotePreview, error) {
	if !IsValidPublicLinkToken(token) {
		return nil, ErrPublicLinkNotFound
	}

	// The first image in the order the app shows them (GetNoteImagesByNoteID:
	// created_at, then id).
	var noteType NoteType
	var preview PublicNotePreview
	var imageID sql.NullString
	var width, height sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT n.note_type, n.title, i.id, i.width, i.height
		 FROM note_public_links l
		 INNER JOIN active_notes n ON n.id = l.note_id
		 INNER JOIN note_user_state nus ON nus.note_id = n.id AND nus.user_id = n.user_id
		 LEFT JOIN note_images i ON i.id = (
		     SELECT fi.id FROM note_images fi
		     WHERE fi.note_id = n.id
		     ORDER BY fi.created_at, fi.id
		     LIMIT 1
		 )
		 WHERE l.token = ? AND `+activePublicLinkCond),
		token, Timestamp(Now()),
	).Scan(&noteType, &preview.Title, &imageID, &width, &height)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrPublicLinkNotFound
		}
		return nil, fmt.Errorf("failed to get public note preview: %w", err)
	}
	if noteType == NoteTypeText {
		// Mirrors SanitizeNote: a text note has no title.
		preview.Title = ""
	}
	if imageID.Valid {
		preview.FirstImage = &PublicNoteImage{ID: imageID.String, Width: int(width.Int64), Height: int(height.Int64)}
	}
	return &preview, nil
}
