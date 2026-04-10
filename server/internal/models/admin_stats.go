package models

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

type AdminUserStats struct {
	Total  int64 `json:"total"`
	Admins int64 `json:"admins"`
}

type AdminNoteStats struct {
	Total    int64 `json:"total"`
	Text     int64 `json:"text"`
	List     int64 `json:"list"`
	Trashed  int64 `json:"trashed"`
	Archived int64 `json:"archived"`
}

type AdminSharingStats struct {
	SharedNotes int64 `json:"shared_notes"`
	ShareLinks  int64 `json:"share_links"`
}

type AdminLabelStats struct {
	Total            int64 `json:"total"`
	NoteAssociations int64 `json:"note_associations"`
}

type AdminListItemStats struct {
	Total     int64 `json:"total"`
	Completed int64 `json:"completed"`
	Assigned  int64 `json:"assigned"`
}

type AdminStorageStats struct {
	DatabaseSizeBytes int64 `json:"database_size_bytes"`
}

type AdminStats struct {
	Users     AdminUserStats     `json:"users"`
	Notes     AdminNoteStats     `json:"notes"`
	Sharing   AdminSharingStats  `json:"sharing"`
	Labels    AdminLabelStats    `json:"labels"`
	ListItems AdminListItemStats `json:"list_items"`
	Storage   AdminStorageStats  `json:"storage"`
}

type adminStatsStore struct {
	db *sql.DB
	d  *dialect.Dialect
}

func newAdminStatsStore(db *sql.DB, d *dialect.Dialect) *adminStatsStore {
	return &adminStatsStore{db: db, d: d}
}

func (s *adminStatsStore) GetStats(ctx context.Context) (*AdminStats, error) {
	stats := &AdminStats{}

	if err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0)
		FROM users
	`)).Scan(&stats.Users.Total, &stats.Users.Admins); err != nil {
		return nil, fmt.Errorf("count users: %w", err)
	}

	if err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN n.note_type = ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN n.note_type = ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN n.deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN nus.archived = 1 AND n.deleted_at IS NULL THEN 1 ELSE 0 END), 0)
		FROM notes n
		LEFT JOIN note_user_state nus ON n.id = nus.note_id AND nus.user_id = n.user_id
	`), NoteTypeText, NoteTypeList).Scan(
		&stats.Notes.Total,
		&stats.Notes.Text,
		&stats.Notes.List,
		&stats.Notes.Trashed,
		&stats.Notes.Archived,
	); err != nil {
		return nil, fmt.Errorf("count notes: %w", err)
	}

	if err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`
		SELECT
			COUNT(DISTINCT note_id),
			COUNT(*)
		FROM note_shares
	`)).Scan(&stats.Sharing.SharedNotes, &stats.Sharing.ShareLinks); err != nil {
		return nil, fmt.Errorf("count note shares: %w", err)
	}

	if err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`
		SELECT
			(SELECT COUNT(*) FROM labels),
			(SELECT COUNT(*) FROM note_labels)
	`)).Scan(&stats.Labels.Total, &stats.Labels.NoteAssociations); err != nil {
		return nil, fmt.Errorf("count labels: %w", err)
	}

	if err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(`
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN assigned_to IS NOT NULL THEN 1 ELSE 0 END), 0)
		FROM note_items
	`)).Scan(&stats.ListItems.Total, &stats.ListItems.Completed, &stats.ListItems.Assigned); err != nil {
		return nil, fmt.Errorf("count note items: %w", err)
	}

	return stats, nil
}
