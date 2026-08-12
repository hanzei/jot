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
