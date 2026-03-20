package models

import (
	"database/sql"
	"iter"
)

// scanRows returns an iterator over database rows, calling scan for each row.
// The caller is responsible for closing the rows (e.g. via defer rows.Close()).
func scanRows[T any](rows *sql.Rows, scan func(*sql.Rows) (T, error)) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		for rows.Next() {
			item, err := scan(rows)
			if !yield(item, err) || err != nil {
				return
			}
		}
		if err := rows.Err(); err != nil {
			var zero T
			yield(zero, err)
		}
	}
}

// collectRows queries rows and collects results into a slice using the
// provided scan function. It closes the rows when done.
func collectRows[T any](rows *sql.Rows, scan func(*sql.Rows) (T, error)) ([]T, error) {
	defer func() { _ = rows.Close() }()
	var result []T
	for item, err := range scanRows(rows, scan) {
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}
