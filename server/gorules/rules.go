//go:build ruleguard

package gorules

import "github.com/quasilyte/go-ruleguard/dsl"

// fmt.Errorf("%w", err) adds no context: same message, same errors.Is match.
func noopErrorWrap(m dsl.Matcher) {
	m.Match(`fmt.Errorf("%w", $err)`).
		Report(`no-op wrap: return $err directly (server/CLAUDE.md)`)
}
