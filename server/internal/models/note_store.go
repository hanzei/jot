package models

import (
	"database/sql"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

type noteStore struct {
	db *sql.DB
	d  *dialect.Dialect
}

func newNoteStore(db *sql.DB, d *dialect.Dialect) *noteStore {
	return &noteStore{db: db, d: d}
}

// deref returns *p if p is non-nil, otherwise def.
func deref[T any](p *T, def T) T {
	if p != nil {
		return *p
	}
	return def
}

// NewNoteItem describes a list item to insert atomically as part of note
// creation. ID is the caller-supplied item ID, or "" to generate one
// server-side. ParentID is the resolved parent item ID within the same note
// ("" for a top-level item); the caller computes it (e.g. from indent levels)
// before calling CreateWithItems.
type NewNoteItem struct {
	ID        string
	Text      string
	Position  int
	Completed bool
	ParentID  string
}
