import { trimTrailingSlashes } from './api/paths';
import type { PublicLink } from './types';

/** Path of the webapp page that shows a note through its public link. */
export const PUBLIC_NOTE_PATH_PREFIX = '/share/';

/**
 * The URL of a public note link, as people outside the instance open it.
 *
 * `baseUrl` is `public_url` from `GET /config` when the operator set
 * `JOT_PUBLIC_URL`, and otherwise the client's own address
 * (`window.location.origin` on web, the connected server URL on mobile). Web
 * and mobile both build links here so they come out identical.
 */
export function publicNoteUrl(baseUrl: string, token: string): string {
  return trimTrailingSlashes(baseUrl) + PUBLIC_NOTE_PATH_PREFIX + encodeURIComponent(token);
}

/**
 * The URL to hand out for `link`: built on `publicUrl` (`public_url` from
 * `GET /config`, set by the operator's `JOT_PUBLIC_URL`) when set, since the
 * client may reach Jot on an address outsiders cannot use (an internal
 * hostname, a LAN IP, a VPN name), and on `fallbackBaseUrl` otherwise: the
 * page's origin on web, the connected server URL on mobile.
 */
export function publicLinkUrl(
  link: Pick<PublicLink, 'token'>,
  publicUrl: string | null | undefined,
  fallbackBaseUrl: string,
): string {
  return publicNoteUrl(publicUrl ?? fallbackBaseUrl, link.token);
}

/** The expiry choices offered when creating a public link or changing its expiry. */
export const PUBLIC_LINK_EXPIRY_CHOICES = ['never', '7d', '30d', '3m'] as const;
export type PublicLinkExpiryChoice = (typeof PUBLIC_LINK_EXPIRY_CHOICES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `expires_at` to send for `choice`, counted from `now`: `null` for a link
 * that never expires. "3 months" is calendar months, so it lands on the same
 * day of the month (clamped by `Date` where that day does not exist).
 */
export function publicLinkExpiresAt(choice: PublicLinkExpiryChoice, now: Date = new Date()): string | null {
  switch (choice) {
    case 'never':
      return null;
    case '7d':
      return new Date(now.getTime() + 7 * DAY_MS).toISOString();
    case '30d':
      return new Date(now.getTime() + 30 * DAY_MS).toISOString();
    case '3m': {
      const expires = new Date(now.getTime());
      expires.setMonth(expires.getMonth() + 3);
      return expires.toISOString();
    }
  }
}

/**
 * Whether `link` still works. The server returns an expired link as `null`, but
 * a note loaded or cached earlier can hold one that has expired since.
 */
export function isPublicLinkActive(link: PublicLink | null | undefined, now: Date = new Date()): link is PublicLink {
  return !!link && (link.expires_at === null || new Date(link.expires_at).getTime() > now.getTime());
}
