package models

import (
	"errors"

	sqlitedriver "modernc.org/sqlite"
)

// sqliteUniqueConstraint is the SQLite extended error code for UNIQUE constraint violations.
const sqliteUniqueConstraint = 2067

func isUniqueConstraintError(err error) bool {
	var sqliteErr *sqlitedriver.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code() == sqliteUniqueConstraint
}
