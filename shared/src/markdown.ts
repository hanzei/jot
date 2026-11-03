// Cross-client Markdown helpers.
//
// Both clients lex with marked and normalize through blockMarkdown.ts and
// inlineMarkdown.ts, so only the renderers differ — the webapp emits HTML behind
// a DOMPurify allowlist, mobile a tree of React Native components. The pieces
// those two renderers have to agree on *exactly* — and would otherwise drift
// apart unnoticed — live here.
//
// The feature set itself is specified in docs/specs/markdown-rendering.md.

/**
 * URL schemes Jot turns into links. A link with any other scheme, or with no
 * scheme at all, renders as plain text on both clients.
 */
export const ALLOWED_LINK_SCHEMES = ['http', 'https', 'mailto'] as const;

/**
 * Whether a link target may be rendered as a link.
 *
 * Requires an explicit allowed scheme: `tel:`, `sms:` and app deep links are
 * rejected, and so are scheme-less targets (`/foo`, `example.com`,
 * `//example.com`) — notes are shareable, so a collaborator's note must not be
 * able to drive navigation anywhere but the web and mail.
 *
 * This runs on the target the *parser* produced, which is not always what the
 * author typed: both clients autolink `www.example.com` and hand this an
 * already-normalized `http://www.example.com`, so that is accepted by design.
 * What each parser is willing to autolink in the first place is settled
 * upstream of here — see `gfmAutolinksOnly` in mobile/src/utils/markdown.tsx.
 */
export function isAllowedLinkHref(href: string): boolean {
  const scheme = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (!scheme) return false;
  // The group is not optional, so a match always captured it.
  return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(scheme[1]!.toLowerCase());
}

/**
 * A link target encoded as the address a client opens, or null when it cannot
 * be encoded (a lone surrogate makes `encodeURI` throw).
 *
 * This is marked's own `cleanUrl` step: encode, then undo the `%` → `%25`
 * double-encoding so an already-encoded target (`.../Caf%C3%A9`) round-trips
 * unchanged. Running it twice is therefore harmless. It also encodes the space
 * in `<https://example.com/a b>`, which `Linking.openURL` would otherwise be
 * handed raw, and the quote that would close an `href` attribute early.
 *
 * Applied once, in the inline normalizer, so a link node's `href` is already
 * the final address on both clients and duplicates are judged on it.
 */
export function encodeLinkHref(href: string): string | null {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/**
 * The literal source shown in place of an image, which Jot does not render
 * (images are a separate gallery feature, shown above the note body).
 *
 * Both clients reconstruct this from parsed tokens rather than echoing the
 * original source, so the format is pinned here: if one side dropped the title
 * or the leading `!`, `![a](b "t")` would quietly diverge again.
 */
export function formatLiteralImage(alt: string, src: string, title?: string | null): string {
  return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
}
