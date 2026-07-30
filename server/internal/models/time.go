package models

import "time"

// Now returns the current time in UTC. Use it instead of time.Now for any value
// that is persisted to, or compared against, a timestamp column.
//
// Timestamp columns are naive on both backends (SQLite DATETIME, PostgreSQL
// TIMESTAMP WITHOUT TIME ZONE): the wall-clock value handed to the driver is
// what gets stored, and it is later compared against cutoffs such as session
// expiry and trash purge. A bare time.Now would store the server's local wall
// clock and make those comparisons drift by its UTC offset. Timestamps the
// database generates itself (DEFAULT CURRENT_TIMESTAMP) are UTC too — SQLite's
// always is, and PostgreSQL sessions are pinned to UTC when the pool is opened.
func Now() time.Time {
	return time.Now().UTC()
}
