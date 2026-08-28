//go:build ruleguard

package gorules

import "github.com/quasilyte/go-ruleguard/dsl"

// fmt.Errorf("%w", err) adds no context: same message, same errors.Is match.
// Scoped to direct return statements only, so the "return $err directly"
// advice is accurate — a nested or assigned use isn't a return site. $err
// must not be the nil literal: fmt.Errorf("%w", nil) is not equivalent to a
// bare nil return, since it still produces a non-nil formatted error.
func noopErrorWrap(m dsl.Matcher) {
	m.Match(`return $*_, fmt.Errorf("%w", $err), $*_`).
		Where(!m["err"].Object.Is("Nil")).
		Report(`no-op wrap: return $err directly (server/CLAUDE.md)`)
}

// Timestamp columns are naive on both backends, so a bare time.Now stores the
// server's local wall clock and makes cutoff comparisons drift by its UTC
// offset — the bug #754 fixed. models.Now is the UTC, microsecond-truncated
// replacement, and nothing but its own definition should call time.Now for a
// value that reaches a column.
//
// Elapsed-time measurement is the legitimate exception (a duration has no time
// zone); those sites carry a //nolint:gocritic with the reason.
//
// Test files are deliberately out of scope: a test that stamps a row wrongly
// fails visibly, where production drift is silent, and covering them would
// mean either churn or blanket suppressions that hide the real cases.
func dbTimeNow(m dsl.Matcher) {
	m.Match(`time.Now()`).
		Where(!m.File().Name.Matches(`_test\.go$`)).
		Report(`use models.Now() for any value persisted to or compared against a timestamp column (CLAUDE.md); //nolint:gocritic if this measures elapsed time`)
}
