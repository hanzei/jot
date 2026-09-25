import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The query parameter the server's SSO callback redirects a failed web flow
 * with: `/login?sso_error=<code>` for sign-in, `/settings?sso_error=<code>`
 * for connecting an account.
 */
export const SSO_ERROR_PARAM = 'sso_error';

export interface SsoErrorMessage {
  /** i18n key of the message to show. */
  key: string;
  /**
   * The user backed out at the identity provider. Shown as a neutral note
   * rather than a failure.
   */
  cancelled: boolean;
}

/** Maps a failed sign-in's `sso_error` code to its message. */
export function ssoLoginErrorMessage(code: string): SsoErrorMessage {
  if (code === 'access_denied') {
    return { key: 'auth.ssoCancelled', cancelled: true };
  }
  return { key: 'auth.ssoFailed', cancelled: false };
}

/** Maps a failed account link's `sso_error` code to its message. */
export function ssoLinkErrorMessage(code: string): SsoErrorMessage {
  switch (code) {
    case 'access_denied':
      return { key: 'settings.ssoLinkCancelled', cancelled: true };
    case 'identity_linked':
      return { key: 'settings.ssoLinkConflict', cancelled: false };
    default:
      return { key: 'settings.ssoLinkFailed', cancelled: false };
  }
}

/**
 * Returns the page's `sso_error` code as it was on mount, and removes it from
 * the URL so a reload or a shared link does not show the message again.
 */
export function useSsoErrorParam(): string | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const [code] = useState(() => searchParams.get(SSO_ERROR_PARAM));

  useEffect(() => {
    if (!searchParams.has(SSO_ERROR_PARAM)) {
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(SSO_ERROR_PARAM);
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  return code;
}
