/** The `/config` fields the public link UI depends on. */
export interface PublicLinksConfig {
  /** `public_links_enabled`: the share dialog's section is hidden when false. */
  enabled: boolean;
  /** `public_url`: the base for copied links, or null to use this page's origin. */
  publicUrl: string | null;
}

/** Public links off: the default until `/config` says otherwise. */
export const PUBLIC_LINKS_DISABLED: PublicLinksConfig = { enabled: false, publicUrl: null };

