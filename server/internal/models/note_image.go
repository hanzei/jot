package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
)

func scanNoteImage(rows *sql.Rows) (NoteImage, error) {
	var img NoteImage
	err := rows.Scan(
		&img.ID, &img.NoteID, &img.UploaderID, &img.Filename, &img.ContentType,
		&img.SizeBytes, &img.SHA256, &img.Width, &img.Height, &img.CreatedAt,
	)
	return img, err
}

// CreateNoteImage inserts a new note_images row and returns the created
// image. When maxImages > 0 the note's image count is checked inside the
// same transaction as the insert and ErrNoteImageCapExceeded is returned if
// adding the image would exceed the cap — atomic, so concurrent uploads to
// the same note cannot race past it (mirrors CreateItemWithID's maxItems
// check). Callers may additionally pre-check the count outside the
// transaction to fail fast before doing upload work (hashing, decoding,
// blob storage) for a note that is already at capacity; that pre-check is
// just an optimization and this one is authoritative.
func (s *noteStore) CreateNoteImage(ctx context.Context, noteID, uploaderID, filename, contentType string, sizeBytes int64, sha256 string, width, height, maxImages int) (*NoteImage, error) {
	imageID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate note image ID: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if maxImages > 0 {
		var count int
		if err = tx.QueryRowContext(ctx,
			s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_images WHERE note_id = ?`),
			noteID,
		).Scan(&count); err != nil {
			return nil, fmt.Errorf("failed to count note images: %w", err)
		}
		if count >= maxImages {
			return nil, ErrNoteImageCapExceeded
		}
	}

	img := NoteImage{
		ID:          imageID,
		NoteID:      noteID,
		UploaderID:  uploaderID,
		Filename:    filename,
		ContentType: contentType,
		SizeBytes:   sizeBytes,
		SHA256:      sha256,
		Width:       width,
		Height:      height,
	}
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_images (id, note_id, uploader_id, filename, content_type, size_bytes, sha256, width, height)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING created_at`),
		imageID, noteID, uploaderID, filename, contentType, sizeBytes, sha256, width, height,
	).Scan(&img.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create note image: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit create note image: %w", err)
	}

	return &img, nil
}

// GetNoteImageByID fetches a single note_images row by ID, for the
// download/delete handlers which need the parent note ID (for the access
// check) and content hash (for blob lookup/reclamation). Returns
// ErrNoteImageNotFound if it doesn't exist.
func (s *noteStore) GetNoteImageByID(ctx context.Context, imageID string) (*NoteImage, error) {
	query := `SELECT id, note_id, uploader_id, filename, content_type, size_bytes, sha256, width, height, created_at
			  FROM note_images
			  WHERE id = ?`

	row := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), imageID)
	var img NoteImage
	err := row.Scan(
		&img.ID, &img.NoteID, &img.UploaderID, &img.Filename, &img.ContentType,
		&img.SizeBytes, &img.SHA256, &img.Width, &img.Height, &img.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteImageNotFound
		}
		return nil, fmt.Errorf("failed to get note image: %w", err)
	}
	return &img, nil
}

// GetNoteImagesByNoteID lists the images attached to a note, in upload order.
func (s *noteStore) GetNoteImagesByNoteID(ctx context.Context, noteID string) ([]NoteImage, error) {
	query := `SELECT id, note_id, uploader_id, filename, content_type, size_bytes, sha256, width, height, created_at
			  FROM note_images
			  WHERE note_id = ?
			  ORDER BY created_at`

	rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get note images: %w", err)
	}

	images, err := collectRows(rows, scanNoteImage)
	if err != nil {
		return nil, fmt.Errorf("failed to scan note images: %w", err)
	}
	if images == nil {
		images = []NoteImage{}
	}
	return images, nil
}

// GetNoteImageCountByNoteID returns the number of images attached to a note.
// Used for the upload handler's fast-path capacity pre-check, which only
// needs a count and would otherwise waste a full row fetch+scan just to
// discard everything but len() (CreateNoteImage's own transactional check is
// what actually enforces the cap).
func (s *noteStore) GetNoteImageCountByNoteID(ctx context.Context, noteID string) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_images WHERE note_id = ?`),
		noteID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count note images: %w", err)
	}
	return count, nil
}

// getNoteImagesByNoteIDs batch-loads images for a set of note IDs, mirroring
// getSharesByNoteIDs/getLabelsByNoteIDs, so listing notes never does one
// images query per note. Chunked at noteIDsQueryBatchSize like
// getSharesByNoteIDs so a large note list can't exceed the driver's
// bound-parameter limit.
func (s *noteStore) getNoteImagesByNoteIDs(ctx context.Context, noteIDs []string) (map[string][]NoteImage, error) {
	if len(noteIDs) == 0 {
		return map[string][]NoteImage{}, nil
	}

	result := map[string][]NoteImage{}

	for chunk := range slices.Chunk(noteIDs, noteIDsQueryBatchSize) {
		placeholders := strings.Join(slices.Repeat([]string{"?"}, len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}

		query := `SELECT id, note_id, uploader_id, filename, content_type, size_bytes, sha256, width, height, created_at
				  FROM note_images
				  WHERE note_id IN (` + placeholders + `)
				  ORDER BY note_id, created_at` // #nosec G202 -- only "?" placeholders are joined, no user input

		rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), args...)
		if err != nil {
			return nil, fmt.Errorf("failed to batch-get note images: %w", err)
		}

		for img, err := range scanRows(rows, scanNoteImage) {
			if err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("failed to scan note image: %w", err)
			}
			result[img.NoteID] = append(result[img.NoteID], img)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("failed to close note images rows: %w", err)
		}
	}

	return result, nil
}

// DeleteNoteImage hard-deletes an image row and returns it. Undo lives
// entirely on the client (a ~10s toast before it ever calls this), so there
// is no soft-delete/restore step here — by the time this is called the
// removal is final. The caller needs the returned SHA256 to call
// GetNoteImageRefCount and decide whether the blob is now orphaned. Returns
// ErrNoteImageNotFound if the image doesn't exist.
func (s *noteStore) DeleteNoteImage(ctx context.Context, imageID string) (*NoteImage, error) {
	query := `DELETE FROM note_images WHERE id = ?
			  RETURNING id, note_id, uploader_id, filename, content_type, size_bytes, sha256, width, height, created_at`

	row := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), imageID)
	var deleted NoteImage
	err := row.Scan(
		&deleted.ID, &deleted.NoteID, &deleted.UploaderID, &deleted.Filename, &deleted.ContentType,
		&deleted.SizeBytes, &deleted.SHA256, &deleted.Width, &deleted.Height, &deleted.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNoteImageNotFound
		}
		return nil, fmt.Errorf("failed to delete note image: %w", err)
	}
	return &deleted, nil
}

// GetNoteImageRefCount returns the number of note_images rows referencing a
// given content hash. Used to decide whether a deleted row's blob can be
// reclaimed (refcount reaches zero) or is still shared by another row (dedup).
func (s *noteStore) GetNoteImageRefCount(ctx context.Context, sha256 string) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT COUNT(*) FROM note_images WHERE sha256 = ?`),
		sha256,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to get note image refcount: %w", err)
	}
	return count, nil
}

// GetNoteImageSHA256sForUserTx returns the distinct sha256 hashes of every
// image reachable from userID: images attached to notes they own, plus
// images they uploaded to notes owned by someone else (a shared note).
// Deleting a user cascades both note_images.note_id (via their owned notes)
// and note_images.uploader_id directly, so this must run inside the same
// transaction as — and before — the user delete: read via tx so it sees a
// consistent snapshot with the delete that follows, and before it because
// looking this up after the cascade has already run would find nothing.
func (s *noteStore) GetNoteImageSHA256sForUserTx(ctx context.Context, tx *sql.Tx, userID string) ([]string, error) {
	query := `SELECT DISTINCT sha256 FROM note_images
			  WHERE uploader_id = ? OR note_id IN (SELECT id FROM notes WHERE user_id = ?)`

	rows, err := tx.QueryContext(ctx, s.d.RewritePlaceholders(query), userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query note image hashes for user: %w", err)
	}
	shas, err := collectRows(rows, func(rows *sql.Rows) (string, error) {
		var sha string
		return sha, rows.Scan(&sha)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to scan note image hashes for user: %w", err)
	}
	return shas, nil
}
