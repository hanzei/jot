package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/labelfold"
)

// labelNameFoldedIndex is the unique index enforcing per-user, case-folded
// label-name uniqueness. It is created by backfillLabelNameFolded rather than
// by a migration, because the rows have to be folded and de-duplicated in Go
// first (see the 000010 migrations).
const labelNameFoldedIndex = "idx_labels_user_id_name_folded"

// backfillLabelNameFolded populates labels.name_folded, merges the duplicates
// that populating it reveals, and creates the unique index over the result.
//
// It runs on both backends and is the only thing that writes name_folded
// outside the stores, so the folded key is computed by labelfold.Fold
// everywhere. No SQL either backend can express computes that function --
// SQLite folds ASCII A-Z only, and PostgreSQL's LOWER() is locale-dependent
// and lower-cases rather than case-folds -- which is why this is Go and not a
// migration.
//
// The whole thing is one transaction and is a no-op once the index exists, so
// it is safe to run on every start: a fresh database reaches the same schema
// by the same path as an upgraded one, and an interrupted run leaves nothing
// half-folded.
//
// Merging is irreversible and user-visible. A user holding both "Äpfel" and
// "äpfel" ends up with one label: no note loses a tag, but the two spellings
// collapse into the older one.
func backfillLabelNameFolded(ctx context.Context, db *sql.DB, driverName string) error {
	d := &dialect.Dialect{Driver: driverName}

	done, err := labelNameFoldedIndexExists(ctx, db, driverName)
	if err != nil {
		return err
	}
	if done {
		return nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin label fold backfill: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	folded, err := foldExistingLabelNames(ctx, tx, d)
	if err != nil {
		return err
	}

	if err := mergeFoldedLabelDuplicates(ctx, tx, d, folded); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		`CREATE UNIQUE INDEX `+labelNameFoldedIndex+` ON labels (user_id, name_folded)`,
	); err != nil {
		return fmt.Errorf("create %s: %w", labelNameFoldedIndex, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit label fold backfill: %w", err)
	}
	tx = nil
	return nil
}

// labelNameFoldedIndexExists reports whether the backfill has already run.
// The index is created last and in the same transaction as the folding, so its
// presence means the whole thing completed.
func labelNameFoldedIndexExists(ctx context.Context, db *sql.DB, driverName string) (bool, error) {
	query := `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`
	if driverName == driverPostgres {
		query = `SELECT 1 FROM pg_indexes WHERE indexname = $1`
	}

	var exists int
	err := db.QueryRowContext(ctx, query, labelNameFoldedIndex).Scan(&exists)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	default:
		return false, fmt.Errorf("check for %s: %w", labelNameFoldedIndex, err)
	}
}

// foldedLabel is one row of labels, with the key it folds to.
type foldedLabel struct {
	id     string
	userID string
	folded string
}

// foldExistingLabelNames computes the folded key for every label and writes it
// back, returning the rows in a stable order: oldest first within a user, which
// is the order mergeFoldedLabelDuplicates uses to pick the survivor.
func foldExistingLabelNames(ctx context.Context, tx *sql.Tx, d *dialect.Dialect) ([]foldedLabel, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT id, user_id, name FROM labels ORDER BY user_id, created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("read labels for folding: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	var labels []foldedLabel
	for rows.Next() {
		var id, userID, name string
		if err := rows.Scan(&id, &userID, &name); err != nil {
			return nil, fmt.Errorf("scan label for folding: %w", err)
		}
		labels = append(labels, foldedLabel{id: id, userID: userID, folded: labelfold.Fold(name)})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate labels for folding: %w", err)
	}

	update := d.RewritePlaceholders(`UPDATE labels SET name_folded = ? WHERE id = ?`)
	for _, l := range labels {
		if _, err := tx.ExecContext(ctx, update, l.folded, l.id); err != nil {
			return nil, fmt.Errorf("write folded name for label %s: %w", l.id, err)
		}
	}
	return labels, nil
}

// mergeFoldedLabelDuplicates collapses labels that fold to the same key for one
// user. The oldest survives; its duplicates' note associations are repointed at
// it, dropping any that the survivor already has, and the duplicates are
// deleted.
//
// This mirrors what migration 000009 did for PostgreSQL's ASCII fold, in Go
// because the grouping key is one labelfold.Fold cannot be expressed in SQL.
func mergeFoldedLabelDuplicates(ctx context.Context, tx *sql.Tx, d *dialect.Dialect, labels []foldedLabel) error {
	type foldKey struct{ userID, folded string }

	keep := make(map[foldKey]string, len(labels))
	repoint := d.RewritePlaceholders(
		`UPDATE note_labels SET label_id = ?
		  WHERE label_id = ? AND user_id = ?
		    AND note_id NOT IN (SELECT note_id FROM note_labels WHERE label_id = ? AND user_id = ?)`)
	dropCollisions := d.RewritePlaceholders(
		`DELETE FROM note_labels WHERE label_id = ? AND user_id = ?`)
	deleteLabel := d.RewritePlaceholders(`DELETE FROM labels WHERE id = ?`)

	for _, l := range labels {
		k := foldKey{userID: l.userID, folded: l.folded}
		survivor, seen := keep[k]
		if !seen {
			// labels is ordered oldest first, so the first row for a key is the
			// one that survives.
			keep[k] = l.id
			continue
		}

		if _, err := tx.ExecContext(ctx, repoint, survivor, l.id, l.userID, survivor, l.userID); err != nil {
			return fmt.Errorf("repoint note labels from %s to %s: %w", l.id, survivor, err)
		}
		// Whatever is left pointed at the duplicate is an association the
		// survivor already has; note_labels is UNIQUE(note_id, label_id,
		// user_id) so it cannot be repointed, only dropped.
		if _, err := tx.ExecContext(ctx, dropCollisions, l.id, l.userID); err != nil {
			return fmt.Errorf("drop duplicate note labels for %s: %w", l.id, err)
		}
		if _, err := tx.ExecContext(ctx, deleteLabel, l.id); err != nil {
			return fmt.Errorf("delete duplicate label %s: %w", l.id, err)
		}
	}
	return nil
}
