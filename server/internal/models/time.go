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
//
// The result is truncated to microseconds, the finest resolution a timestamp
// column can hold (see timestampLayout), so a value kept in memory equals the
// one that comes back out of the database rather than differing in digits the
// column never stored.
func Now() time.Time {
	return time.Now().UTC().Truncate(time.Microsecond)
}

// timestampLayout is the text form every timestamp written by the store layer
// takes. Microseconds are the finest resolution PostgreSQL's TIMESTAMP can
// hold, so formatting to exactly six fractional digits is what makes the two
// backends store byte-identical values: any finer and PostgreSQL would round
// while SQLite kept the full value, putting the two back out of step.
//
// The layout is SQLite's own canonical timestamp format, so values stay
// comparable with rows written by DEFAULT CURRENT_TIMESTAMP (which has no
// fractional part — a shorter string that still orders correctly against these,
// since the seconds field is a common prefix) and stay readable to SQLite's
// date functions and the sqlite3 CLI.
const timestampLayout = "2006-01-02 15:04:05.000000"

// Timestamp renders t for binding into a timestamp column. Bind the result of
// this rather than a time.Time: the SQLite driver stores a bound time.Time in
// Go's own String format ("2006-01-02 15:04:05.999999999 -0700 MST"), which
// SQLite's date functions cannot read, and lib/pq sends full nanoseconds for
// PostgreSQL to round.
//
// Prefer one Timestamp(Now()) per logical operation, shared by every statement
// in it, so all rows a single operation writes carry the same value on both
// backends — PostgreSQL's CURRENT_TIMESTAMP is transaction-constant where
// SQLite's is evaluated per statement, and generating the value here is what
// removes that difference.
func Timestamp(t time.Time) string {
	return t.UTC().Format(timestampLayout)
}
