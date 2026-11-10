/** The `/config` fields the public link UI depends on. */
export interface PublicLinksConfig {
  /** `public_links_enabled`: the share dialog's section is hidden when false. */
  enabled: boolean;
  /** `public_url`: the base for copied links, or null to use this page's origin. */
  publicUrl: string | null;
}

/** Public links off: the default until `/config` says otherwise. */
export const PUBLIC_LINKS_DISABLED: PublicLinksConfig = { enabled: false, publicUrl: null };

/** How many characters of the token `shortPublicLinkUrl` keeps. */
const SHORT_TOKEN_CHARS = 4;

/**
 * `url` (a full public link from `publicLinkUrl`) for display: no scheme, and
 * the token, its last path segment, cut to its first few characters and an
 * ellipsis (`jot.example.com/share/W15w…`). The token is the only key to the
 * note, so the full value must stay off screens, screenshots and screen
 * shares; copying still hands out the full URL.
 */
export function shortPublicLinkUrl(url: string): string {
  const { host, pathname } = new URL(url);
  const tokenStart = pathname.lastIndexOf('/') + 1;
  const token = pathname.slice(tokenStart);
  // Never the whole token, even one shorter than the usual cut.
  const kept = token.slice(0, Math.min(SHORT_TOKEN_CHARS, token.length - 1));
  return `${host}${pathname.slice(0, tokenStart)}${kept}…`;
}
