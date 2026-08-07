// Cross-client Markdown helpers.
//
// The webapp renders Markdown with marked + a DOMPurify allowlist and mobile
// renders it with markdown-it + react-native-markdown-display, so the two reach
// the same feature set by completely different routes. The pieces that have to
// agree *exactly* — and would otherwise drift apart unnoticed — live here.
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
 * The literal source shown in place of an image, which Jot does not render
 * (images are a separate gallery feature — docs/specs/file-attachments.md).
 *
 * Both clients reconstruct this from parsed tokens rather than echoing the
 * original source, so the format is pinned here: if one side dropped the title
 * or the leading `!`, `![a](b "t")` would quietly diverge again.
 */
export function formatLiteralImage(alt: string, src: string, title?: string | null): string {
  return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
}
