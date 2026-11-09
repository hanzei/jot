import { publicNoteUrl, type PublicLink } from '@jot/shared';

/** The `/config` fields the public link UI depends on. */
export interface PublicLinksConfig {
  /** `public_links_enabled`: the share dialog's section is hidden when false. */
  enabled: boolean;
  /** `public_url`: the base for copied links, or null to use this page's origin. */
  publicUrl: string | null;
}

/** Public links off: the default until `/config` says otherwise. */
export const PUBLIC_LINKS_DISABLED: PublicLinksConfig = { enabled: false, publicUrl: null };

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
 * when set, since this browser may reach Jot on an address outsiders cannot
 * use, and on this page's own origin otherwise.
 */
export function publicLinkUrl(link: Pick<PublicLink, 'token'>, publicUrl: string | null, origin: string = window.location.origin): string {
  return publicNoteUrl(publicUrl ?? origin, link.token);
}

/**
 * Whether `link` still works. The server returns an expired link as `null`, but
 * a note loaded earlier can hold one that has expired since.
 */
export function isPublicLinkActive(link: PublicLink | null | undefined, now: Date = new Date()): link is PublicLink {
  return !!link && (link.expires_at === null || new Date(link.expires_at).getTime() > now.getTime());
}
