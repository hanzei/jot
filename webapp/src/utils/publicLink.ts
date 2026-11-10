import { PUBLIC_NOTE_PATH_PREFIX } from '@jot/shared';

/** The `/config` fields the public link UI depends on. */
export interface PublicLinksConfig {
  /** `public_links_enabled`: the share dialog's section is hidden when false. */
  enabled: boolean;
  /** `public_url`: the base for copied links, or null to use this page's origin. */
  publicUrl: string | null;
}

/** Public links off: the default until `/config` says otherwise. */
export const PUBLIC_LINKS_DISABLED: PublicLinksConfig = { enabled: false, publicUrl: null };

/** How many characters of the token the shortened link keeps. */
const VISIBLE_TOKEN_CHARS = 4;

/**
 * The public link for `token` on `baseUrl` (as `publicLinkUrl` takes it), for
 * display only: no scheme, and the token cut to its first few characters and
 * an ellipsis, e.g. `jot.example.com/share/W15w…`. The token is the only key
 * to the note, so the full one stays off the screen, out of screenshots and
 * screen shares; copying uses the full URL. `baseUrl` is a bare origin (the
 * server only accepts one for `public_url`).
 */
export function shortPublicLinkUrl(baseUrl: string, token: string): string {
  return `${new URL(baseUrl).host}${PUBLIC_NOTE_PATH_PREFIX}${token.slice(0, VISIBLE_TOKEN_CHARS)}…`;
}
