package models

import (
	"context"
	"database/sql"
	"encoding/json/v2"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
)

// Note revision coalescing and retention (#1129). These are constants rather
// than configuration: each has an obvious value, and every knob is permanent
// surface area.
const (
	// NoteRevisionCoalesceWindow is how long writes from one writer coalesce
	// into a single revision. Autosave and one-at-a-time item writes would
	// otherwise leave a revision per keystroke batch or checkbox.
	NoteRevisionCoalesceWindow = 10 * time.Minute
	// NoteRevisionsMaxPerNote caps how many revisions one note keeps.
	NoteRevisionsMaxPerNote = 50
	// NoteRevisionsMaxAge is how long a revision is kept.
	NoteRevisionsMaxAge = 90 * 24 * time.Hour
)

// MCPWriteClient is the write client recorded for changes made through the MCP
// server, which sends no X-Client-Id, so an assistant's rewrite never coalesces
// with the same user's edit in the webapp.
const MCPWriteClient = "mcp"

// ErrNoteRevisionNotFound is returned when a revision does not exist or does
// not belong to the note it was requested under.
var ErrNoteRevisionNotFound = errors.New("note revision not found")

// NoteRevisionSummary is a revision's metadata, as listed by
// GET /notes/{id}/revisions. A revision is the note's shared content as it was
// just before a write replaced it.
type NoteRevisionSummary struct {
	ID       string   `json:"id"`
	NoteID   string   `json:"note_id"`
	NoteType NoteType `json:"note_type"`
	Title    string   `json:"title"`
	// ActorID is who last edited the snapshotted content, or null when that is
	// unknown (content written before edits were attributed). It may name a
	// user who has since been deleted.
	ActorID *string `json:"actor_id"`
	// EditedAt is when the snapshotted content was last edited.
	EditedAt time.Time `json:"edited_at"`
	// CreatedAt is when the snapshot was recorded: the moment a write replaced
	// this content.
	CreatedAt time.Time `json:"created_at"`
}

// NoteRevision is one full revision, as returned by
// GET /notes/{id}/revisions/{revision_id}. Content is set for a text note and
// Items for a list note; images are not part of a revision.
type NoteRevision struct {
	NoteRevisionSummary
	Content string             `json:"content"`
	Items   []NoteRevisionItem `json:"items"`
}

// NoteRevisionItem is a list item as stored in a revision.
type NoteRevisionItem struct {
	ID         string  `json:"id"`
	Text       string  `json:"text"`
	Completed  bool    `json:"completed"`
	Position   int     `json:"position"`
	ParentID   *string `json:"parent_id"`
	AssignedTo string  `json:"assigned_to"`
}

type writeClientContextKey struct{}

// WithWriteClient returns a copy of ctx naming the client that makes the
// writes done with it: the X-Client-Id of a webapp tab or mobile app launch, or
// MCPWriteClient. Revisions coalesce per user and client, so an edit from a
// second device or an MCP rewrite always leaves the replaced content in
// history, even within NoteRevisionCoalesceWindow.
func WithWriteClient(ctx context.Context, client string) context.Context {
	return context.WithValue(ctx, writeClientContextKey{}, client)
}

func writeClientFromContext(ctx context.Context) string {
	v, _ := ctx.Value(writeClientContextKey{}).(string)
	return v
}

// pendingRevision is a snapshot of a note's shared content taken at the start
// of a write, before anything changed, to be stored by saveTx once the write
// turns out to change something. The zero value captured nothing (the write
// coalesces into the latest revision, or the note is gone) and saves nothing.
type pendingRevision struct {
	captured         bool
	noteID           string
	noteType         NoteType
	title            string
	content          string
	itemsJSON        string
	actorID          sql.NullString
	editedAt         string
	replacedBy       string
	replacedByClient string
	now              string
}

// captureRevisionTx snapshots note noteID's shared content inside tx, ahead of
// a write by actorID at now, unless the write coalesces: the note's latest
// revision was recorded within NoteRevisionCoalesceWindow for the same actor
// and write client (see WithWriteClient). Every write to a note's shared
// content calls it before changing anything, and stores the result with saveTx
// only if the write applied.
//
// It locks the note row (on Postgres) until tx ends, so concurrent writes to
// one note take their snapshots one after another rather than both deciding to
// snapshot the same content.
func captureRevisionTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, actorID, now string) (pendingRevision, error) {
	return snapshotNoteTx(ctx, tx, d, noteID, actorID, now, true)
}

// snapshotNoteTx is captureRevisionTx, coalescing only when coalesce is set.
// Restoring a revision snapshots unconditionally, so the content a restore
// replaces is always in history and the restore can be undone.
func snapshotNoteTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, actorID, now string, coalesce bool) (pendingRevision, error) {
	rev := pendingRevision{
		captured:         true,
		noteID:           noteID,
		replacedBy:       actorID,
		replacedByClient: writeClientFromContext(ctx),
		now:              now,
	}

	var changedAt *time.Time
	var updatedAt time.Time
	err := tx.QueryRowContext(ctx,
		d.RewritePlaceholders(`SELECT note_type, title, content, content_changed_at, content_changed_by, updated_at
			FROM notes WHERE id = ? AND deleted_at IS NULL`+d.ForUpdate()),
		noteID,
	).Scan(&rev.noteType, &rev.title, &rev.content, &changedAt, &rev.actorID, &updatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// The write itself reports the missing note.
			return pendingRevision{}, nil
		}
		return pendingRevision{}, fmt.Errorf("read note for revision: %w", err)
	}
	// content_changed_at is NULL for content predating unread tracking.
	rev.editedAt = Timestamp(deref(changedAt, updatedAt))

	if coalesce {
		coalesced, coalesceErr := revisionCoalescesTx(ctx, tx, d, noteID, rev.replacedBy, rev.replacedByClient, now)
		if coalesceErr != nil {
			return pendingRevision{}, coalesceErr
		}
		if coalesced {
			return pendingRevision{}, nil
		}
	}

	items := []NoteRevisionItem{}
	if rev.noteType == NoteTypeList {
		if items, err = revisionItemsTx(ctx, tx, d, noteID); err != nil {
			return pendingRevision{}, err
		}
	}
	// A blank note (typically one just created) has nothing worth restoring,
	// and would otherwise open every note's history.
	if rev.title == "" && rev.content == "" && len(items) == 0 {
		return pendingRevision{}, nil
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return pendingRevision{}, fmt.Errorf("encode revision items: %w", err)
	}
	rev.itemsJSON = string(itemsJSON)
	return rev, nil
}

// revisionCoalescesTx reports whether a write by actorID from client at now
// folds into the note's latest revision instead of snapshotting again.
func revisionCoalescesTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID, actorID, client, now string) (bool, error) {
	var replacedBy, replacedByClient string
	var createdAt time.Time
	err := tx.QueryRowContext(ctx,
		d.RewritePlaceholders(`SELECT replaced_by, replaced_by_client, created_at FROM note_revisions
			WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`),
		noteID,
	).Scan(&replacedBy, &replacedByClient, &createdAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("read latest note revision: %w", err)
	}
	nowTime, err := time.Parse(timestampLayout, now)
	if err != nil {
		return false, fmt.Errorf("parse write time: %w", err)
	}
	return replacedBy == actorID && replacedByClient == client &&
		createdAt.After(nowTime.Add(-NoteRevisionCoalesceWindow)), nil
}

// revisionItemsTx reads note noteID's items in display order for a snapshot.
func revisionItemsTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string) ([]NoteRevisionItem, error) {
	rows, err := tx.QueryContext(ctx,
		d.RewritePlaceholders(`SELECT id, text, completed, position, parent_id, assigned_to
			FROM note_items WHERE note_id = ? `+itemReadOrder),
		noteID,
	)
	if err != nil {
		return nil, fmt.Errorf("read note items for revision: %w", err)
	}
	items, err := collectRows(rows, func(rows *sql.Rows) (NoteRevisionItem, error) {
		var item NoteRevisionItem
		var parentID, assignedTo sql.NullString
		scanErr := rows.Scan(&item.ID, &item.Text, &item.Completed, &item.Position, &parentID, &assignedTo)
		item.ParentID = parentIDPtr(parentID)
		item.AssignedTo = assignedTo.String
		return item, scanErr
	})
	if err != nil {
		return nil, fmt.Errorf("scan note items for revision: %w", err)
	}
	if items == nil {
		items = []NoteRevisionItem{}
	}
	return items, nil
}

// saveTx stores the captured snapshot, if any, inside tx.
func (p pendingRevision) saveTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect) error {
	if !p.captured {
		return nil
	}
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("generate revision ID: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		d.RewritePlaceholders(`INSERT INTO note_revisions (id, note_id, created_at, edited_at, actor_id, note_type, title, content, items_json, replaced_by, replaced_by_client)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		id, p.noteID, p.now, p.editedAt, p.actorID, p.noteType, p.title, p.content, p.itemsJSON, p.replacedBy, p.replacedByClient,
	); err != nil {
		return fmt.Errorf("insert note revision: %w", err)
	}
	// Enforce the per-note cap here rather than in the periodic prune, so
	// writers that never coalesce (collaborators taking turns, a sync loop
	// between two clients) cannot pile up revisions between prunes.
	if _, err = tx.ExecContext(ctx,
		d.RewritePlaceholders(`DELETE FROM note_revisions WHERE note_id = ? AND id NOT IN (
			SELECT id FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
		)`),
		p.noteID, p.noteID, NoteRevisionsMaxPerNote,
	); err != nil {
		return fmt.Errorf("trim note revisions: %w", err)
	}
	return nil
}

// revisionColumns are the columns scanned by scanNoteRevision, in order.
const revisionColumns = `id, note_id, note_type, title, actor_id, edited_at, created_at, content, items_json`

func scanNoteRevision(rows *sql.Rows) (NoteRevision, error) {
	var rev NoteRevision
	var itemsJSON string
	if err := rows.Scan(&rev.ID, &rev.NoteID, &rev.NoteType, &rev.Title, &rev.ActorID,
		&rev.EditedAt, &rev.CreatedAt, &rev.Content, &itemsJSON); err != nil {
		return rev, err
	}
	if err := json.Unmarshal([]byte(itemsJSON), &rev.Items); err != nil {
		return rev, fmt.Errorf("decode revision items: %w", err)
	}
	if rev.Items == nil {
		rev.Items = []NoteRevisionItem{}
	}
	return rev, nil
}

// ListRevisions returns note noteID's revisions, newest first, as userID sees
// them: metadata only. A note userID cannot access, or that is in the trash,
// is ErrNoteNotFound.
func (s *noteStore) ListRevisions(ctx context.Context, noteID, userID string) ([]NoteRevisionSummary, error) {
	if err := s.requireAccess(ctx, noteID, userID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		s.d.RewritePlaceholders(`SELECT id, note_id, note_type, title, actor_id, edited_at, created_at
			FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC, id DESC`),
		noteID,
	)
	if err != nil {
		return nil, fmt.Errorf("list note revisions: %w", err)
	}
	revisions, err := collectRows(rows, func(rows *sql.Rows) (NoteRevisionSummary, error) {
		var rev NoteRevisionSummary
		scanErr := rows.Scan(&rev.ID, &rev.NoteID, &rev.NoteType, &rev.Title, &rev.ActorID, &rev.EditedAt, &rev.CreatedAt)
		return rev, scanErr
	})
	if err != nil {
		return nil, fmt.Errorf("scan note revisions: %w", err)
	}
	if revisions == nil {
		revisions = []NoteRevisionSummary{}
	}
	return revisions, nil
}

// GetRevision returns one full revision of note noteID. A note userID cannot
// access is ErrNoteNotFound; a revision of another note, or none at all, is
// ErrNoteRevisionNotFound.
func (s *noteStore) GetRevision(ctx context.Context, noteID, revisionID, userID string) (*NoteRevision, error) {
	if err := s.requireAccess(ctx, noteID, userID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		s.d.RewritePlaceholders(`SELECT `+revisionColumns+` FROM note_revisions WHERE id = ? AND note_id = ?`),
		revisionID, noteID,
	)
	if err != nil {
		return nil, fmt.Errorf("get note revision: %w", err)
	}
	revisions, err := collectRows(rows, scanNoteRevision)
	if err != nil {
		return nil, fmt.Errorf("scan note revision: %w", err)
	}
	if len(revisions) == 0 {
		return nil, ErrNoteRevisionNotFound
	}
	return &revisions[0], nil
}

// requireAccess returns ErrNoteNotFound unless userID can access the active
// note noteID.
func (s *noteStore) requireAccess(ctx context.Context, noteID, userID string) error {
	hasAccess, err := s.HasAccess(ctx, noteID, userID)
	if err != nil {
		return err
	}
	if !hasAccess {
		return ErrNoteNotFound
	}
	return nil
}

// RestoreRevision makes note noteID's shared content what revision revisionID
// recorded, as userID, and returns the note as userID sees it. It is an
// ordinary content write through ConvertType, whatever the two types: it is
// gated on baseVersion like any other, converts the note back when the
// revision has another type, and always snapshots the content it replaces,
// even within the coalescing window, so a restore can itself be undone. A
// revision that matches the note as it is writes nothing, so restoring it does
// not bump the version or flag the note updated for collaborators.
//
// Restored items keep their IDs. An item's assignee is restored only if the
// note is still shared and they can still access it (see convertType);
// otherwise the item comes back unassigned.
func (s *noteStore) RestoreRevision(ctx context.Context, noteID, revisionID, userID string, baseVersion *int) (*Note, error) {
	rev, err := s.GetRevision(ctx, noteID, revisionID, userID)
	if err != nil {
		return nil, err
	}
	current, err := s.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, err
	}
	if revisionMatchesNote(rev, current) {
		return current, nil
	}

	var items []NewNoteItem
	if rev.NoteType == NoteTypeList {
		items = make([]NewNoteItem, 0, len(rev.Items))
		for _, item := range rev.Items {
			items = append(items, NewNoteItem{
				ID:         item.ID,
				Text:       item.Text,
				Position:   item.Position,
				Completed:  item.Completed,
				ParentID:   deref(item.ParentID, ""),
				AssignedTo: item.AssignedTo,
			})
		}
	}
	return s.convertType(ctx, noteID, userID, rev.NoteType, rev.Title, rev.Content, items, baseVersion, false)
}

// revisionMatchesNote reports whether restoring rev would leave note as it is.
func revisionMatchesNote(rev *NoteRevision, note *Note) bool {
	if rev.NoteType != note.NoteType || rev.Title != note.Title || rev.Content != note.Content || len(rev.Items) != len(note.Items) {
		return false
	}
	for i, item := range rev.Items {
		current := note.Items[i]
		if item.Text != current.Text || item.Completed != current.Completed ||
			deref(item.ParentID, "") != deref(current.ParentID, "") || item.AssignedTo != current.AssignedTo {
			return false
		}
	}
	return true
}

// dropUnassignableTx clears the assignee of every item in items that cannot be
// assigned on note noteID as it is inside tx: mirroring the item endpoints, an
// assignee must be the owner or a collaborator, and nobody can be assigned on
// a note that is not shared.
func dropUnassignableTx(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, noteID string, items []NewNoteItem) ([]NewNoteItem, error) {
	if !slices.ContainsFunc(items, func(item NewNoteItem) bool { return item.AssignedTo != "" }) {
		return items, nil
	}
	rows, err := tx.QueryContext(ctx,
		d.RewritePlaceholders(`SELECT user_id FROM notes WHERE id = ?
			UNION SELECT shared_with_user_id FROM note_shares WHERE note_id = ?`),
		noteID, noteID,
	)
	if err != nil {
		return nil, fmt.Errorf("query note audience: %w", err)
	}
	audience, err := collectRows(rows, scanString)
	if err != nil {
		return nil, fmt.Errorf("scan note audience: %w", err)
	}
	// The owner is always in the audience, so one member means no shares.
	shared := len(audience) > 1

	filtered := slices.Clone(items)
	for i := range filtered {
		if !shared || !slices.Contains(audience, filtered[i].AssignedTo) {
			filtered[i].AssignedTo = ""
		}
	}
	return filtered, nil
}

// PruneRevisions deletes revisions older than NoteRevisionsMaxAge and returns
// how many it deleted. The per-note count cap is enforced as each revision is
// stored (see saveTx), and a deleted note's revisions go with it through the
// cascade.
func (s *noteStore) PruneRevisions(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`DELETE FROM note_revisions WHERE created_at < ?`),
		Timestamp(Now().Add(-NoteRevisionsMaxAge)),
	)
	if err != nil {
		return 0, fmt.Errorf("prune note revisions: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to get rows affected: %w", err)
	}
	return deleted, nil
}
