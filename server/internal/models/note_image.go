package models

import (
	"context"
	"database/sql"
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

// CreateNoteImage inserts a new note_images row and returns the created image.
func (s *noteStore) CreateNoteImage(ctx context.Context, noteID, uploaderID, filename, contentType string, sizeBytes int64, sha256 string, width, height int) (*NoteImage, error) {
	imageID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate note image ID: %w", err)
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
	err = s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`INSERT INTO note_images (id, note_id, uploader_id, filename, content_type, size_bytes, sha256, width, height)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING created_at`),
		imageID, noteID, uploaderID, filename, contentType, sizeBytes, sha256, width, height,
	).Scan(&img.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create note image: %w", err)
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

// getNoteImagesByNoteIDs batch-loads images for a set of note IDs in a
// single query, mirroring getSharesByNoteIDs/getLabelsByNoteIDs, so listing
// notes never does one images query per note.
func (s *noteStore) getNoteImagesByNoteIDs(ctx context.Context, noteIDs []string) (map[string][]NoteImage, error) {
	if len(noteIDs) == 0 {
		return map[string][]NoteImage{}, nil
	}

	placeholders := strings.Join(slices.Repeat([]string{"?"}, len(noteIDs)), ",")
	args := make([]any, len(noteIDs))
	for i, id := range noteIDs {
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

	defer func() { _ = rows.Close() }()
	result := map[string][]NoteImage{}
	for img, err := range scanRows(rows, scanNoteImage) {
		if err != nil {
			return nil, fmt.Errorf("failed to scan note image: %w", err)
		}
		result[img.NoteID] = append(result[img.NoteID], img)
	}
	return result, nil
}

// DeleteNoteImage hard-deletes an image row. Undo lives entirely on the
// client (a ~10s toast before it ever calls this), so there is no
// soft-delete/restore step here — by the time this is called the removal is
// final. Returns ErrNoteImageNotFound if the image doesn't exist.
func (s *noteStore) DeleteNoteImage(ctx context.Context, imageID string) error {
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_images WHERE id = ?`),
		imageID,
	)
	if err != nil {
		return fmt.Errorf("failed to delete note image: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteImageNotFound
	}
	return nil
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
