import { publicNoteUrl, type PublicLink } from '@jot/shared';

// Mirrors webapp/src/utils/publicLink.ts so both clients offer the same
// choices and compute the same expiry.

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
 * The URL to hand out for `link`: built on the operator's `JOT_PUBLIC_URL`
 * when set, since the app may reach the server on an address outsiders cannot
 * use (a LAN IP, a VPN name), and on the connected server URL otherwise.
 */
export function publicLinkUrl(link: Pick<PublicLink, 'token'>, publicUrl: string | null | undefined, serverUrl: string): string {
  return publicNoteUrl(publicUrl ?? serverUrl, link.token);
}

/**
 * Whether `link` still works. The server returns an expired link as `null`, but
 * a cached note can hold one that has expired since.
 */
export function isPublicLinkActive(link: PublicLink | null | undefined, now: Date = new Date()): link is PublicLink {
  return !!link && (link.expires_at === null || new Date(link.expires_at).getTime() > now.getTime());
}
