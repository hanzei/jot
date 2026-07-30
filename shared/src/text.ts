// Text-length helpers that measure in Unicode code points, matching the
// server. Every character limit in `VALIDATION` is enforced server-side with
// `utf8.RuneCountInString` (see server/internal/handlers/validation.go), while
// JavaScript's `.length` and `.slice` operate on UTF-16 code units. The two
// agree for BMP text but not for astral characters — emoji, CJK extensions,
// musical and mathematical symbols — where one code point is two UTF-16 units.
//
// Using `.length` there rejects input the server would accept; using `.slice`
// there can cut between the two halves of a surrogate pair, producing a string
// that `JSON.stringify` emits as an escaped lone surrogate and Go's
// `json.Unmarshal` silently replaces with U+FFFD.
//
// These match the server's *code point* semantics, not grapheme clusters. A
// ZWJ sequence like 👩‍👩‍👧 is one perceived character but several code points,
// so truncation can still split it into its parts. That is deliberate: the
// goal is for client and server to agree, and changing what "500 characters"
// means is a separate decision that would have to start on the server.

// Spreading a string iterates it by code point rather than by UTF-16 unit.
export const codePointLength = (s: string): number => [...s].length;

// Reports whether s is longer than max code points.
//
// Prefer this over `codePointLength(s) > max` on hot paths: the note editor
// validates on every keystroke, and the `s.length` guard means in-limit text
// never materializes an array. It is a sound short-circuit because a string's
// UTF-16 length is always >= its code point count, so anything that already
// fits by `.length` fits by code points too.
export const exceedsCodePointLimit = (s: string, max: number): boolean =>
  s.length > max && codePointLength(s) > max;

// Returns s truncated to at most max code points, never splitting a surrogate
// pair. Same `.length` short-circuit as exceedsCodePointLimit.
export const truncateToCodePoints = (s: string, max: number): string =>
  s.length <= max ? s : [...s].slice(0, max).join('');
