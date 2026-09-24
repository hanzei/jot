import * as WebBrowser from 'expo-web-browser';
import { getBaseUrl } from '../api/client';
import { createPkcePair } from '../utils/pkce';
import { OIDC_CALLBACK_URL, isOidcCallbackUrl } from '../utils/deepLink';

/**
 * The native SSO hand-off (docs/specs/oidc-sso.md §10.3): open the server's
 * `/auth/oidc/native/start` in the system browser sheet and turn the
 * `jot://oidc-callback` redirect into a one-time code plus the PKCE verifier
 * that redeems it. Redeeming (exchange for login, link for Settings) is the
 * caller's job.
 *
 * The pending flow — the verifier and the server it targets — lives in this
 * module's memory only: never in storage, never in logs. A callback is only
 * accepted while a flow is pending and while that flow's server is still the
 * active one, so an injected `jot://oidc-callback?code=…` is inert.
 */

export type OidcIntent = 'login' | 'link';

export type OidcFlowOutcome =
  // The IdP round trip succeeded; redeem `code` with `codeVerifier`.
  | { type: 'code'; code: string; codeVerifier: string }
  // The user closed the browser sheet (or it showed an error page they
  // dismissed). A quiet return, not an error.
  | { type: 'cancelled' }
  // A terminal failure; `messageKey` is an i18n key.
  | { type: 'error'; messageKey: string };

/** A terminal SSO failure reported before any request; `messageKey` is an i18n key. */
export class SsoFlowError extends Error {
  readonly messageKey: string;

  constructor(messageKey: string) {
    super(messageKey);
    this.name = 'SsoFlowError';
    this.messageKey = messageKey;
  }
}

interface PendingFlow {
  /** Canonical origin of the server the flow started on. */
  baseUrl: string;
  codeVerifier: string;
}

let pendingFlow: PendingFlow | null = null;

export function isOidcFlowPending(): boolean {
  return pendingFlow !== null;
}

/** Test-only: drop any pending flow. */
export function resetOidcFlowForTests(): void {
  pendingFlow = null;
}

export function buildOidcStartUrl(baseUrl: string, intent: OidcIntent, codeChallenge: string): string {
  return `${baseUrl}/api/v1/auth/oidc/native/start?intent=${intent}&code_challenge=${encodeURIComponent(codeChallenge)}`;
}

/**
 * Maps a callback `?error=` code (#1002) to a message key. `access_denied` is
 * the user declining at the IdP, so it reads as a cancellation rather than a
 * failure.
 */
export function oidcCallbackErrorMessageKey(error: string): string {
  switch (error) {
    case 'access_denied':
      return 'auth.ssoCancelled';
    case 'temporarily_unavailable':
      return 'auth.ssoTryAgainLater';
    default:
      return 'auth.ssoFailed';
  }
}

// Manual query parsing: Hermes' URL/URLSearchParams support is incomplete.
function parseQuery(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return params;
  }
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (!params.has(key)) {
        params.set(key, decodeURIComponent(rawValue.replace(/\+/g, ' ')));
      }
    } catch {
      // A malformed escape: skip the pair.
    }
  }
  return params;
}

/**
 * Resolves a `jot://oidc-callback` URL against the pending flow and consumes
 * it. Returns null — the URL is ignored — when no flow is pending or the URL
 * is not the callback.
 */
export function resolveOidcCallback(url: string): OidcFlowOutcome | null {
  const flow = pendingFlow;
  if (!flow || !isOidcCallbackUrl(url)) {
    return null;
  }
  pendingFlow = null;

  const params = parseQuery(url);
  const error = params.get('error');
  if (error !== undefined) {
    return { type: 'error', messageKey: oidcCallbackErrorMessageKey(error) };
  }
  const code = params.get('code');
  if (!code) {
    return { type: 'error', messageKey: 'auth.ssoFailed' };
  }
  // The code is only good at the server that issued it, and the session it
  // yields is stored under the active server, so both must still agree.
  if (getBaseUrl() !== flow.baseUrl) {
    return { type: 'error', messageKey: 'auth.ssoServerChanged' };
  }
  return { type: 'code', code, codeVerifier: flow.codeVerifier };
}

/**
 * Runs the browser half of the flow against the active server. Resolves to a
 * code to redeem, a quiet cancellation, or a terminal error; never rejects.
 * A second call while a flow is pending resolves as cancelled rather than
 * starting a competing one.
 */
export async function runOidcBrowserFlow(intent: OidcIntent): Promise<OidcFlowOutcome> {
  if (pendingFlow) {
    return { type: 'cancelled' };
  }
  let flow: PendingFlow;
  let startUrl: string;
  try {
    const { codeVerifier, codeChallenge } = await createPkcePair();
    const baseUrl = getBaseUrl();
    flow = { baseUrl, codeVerifier };
    startUrl = buildOidcStartUrl(baseUrl, intent, codeChallenge);
  } catch {
    return { type: 'error', messageKey: 'auth.ssoFailed' };
  }
  if (pendingFlow) {
    return { type: 'cancelled' };
  }
  pendingFlow = flow;

  try {
    const result = await WebBrowser.openAuthSessionAsync(startUrl, OIDC_CALLBACK_URL);
    if (pendingFlow !== flow) {
      // Consumed or cleared while the sheet was open.
      return { type: 'cancelled' };
    }
    if (result.type !== 'success') {
      return { type: 'cancelled' };
    }
    return resolveOidcCallback(result.url) ?? { type: 'error', messageKey: 'auth.ssoFailed' };
  } catch {
    // No browser available, or the native module failed to open one.
    return { type: 'error', messageKey: 'auth.ssoFailed' };
  } finally {
    if (pendingFlow === flow) {
      pendingFlow = null;
    }
  }
}

function getHttpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

function getServerMessage(error: unknown): string | undefined {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  return typeof data === 'string' && data.trim() ? data.trim() : undefined;
}

/**
 * Message (i18n key or server text) for a failed `/native/exchange`. A 400 is
 * a bad, expired, or already-used code — the server's text for it is
 * technical, so it gets the generic retry message.
 */
export function oidcExchangeErrorMessage(error: unknown): string {
  const status = getHttpStatus(error);
  if (status === undefined) {
    return 'auth.unableToConnect';
  }
  if (status === 400) {
    return 'auth.ssoFailed';
  }
  return getServerMessage(error) ?? 'auth.ssoFailed';
}

/** Message (i18n key or server text) for a failed `/native/link`. */
export function oidcLinkErrorMessage(error: unknown): string {
  const status = getHttpStatus(error);
  if (status === undefined) {
    return 'auth.unableToConnect';
  }
  if (status === 409) {
    return 'settings.ssoLinkConflict';
  }
  if (status === 403) {
    return 'settings.ssoLinkUnavailable';
  }
  return 'settings.ssoLinkFailed';
}

/** Message (i18n key or server text) for a failed `/auth/oidc/unlink`. */
export function oidcUnlinkErrorMessage(error: unknown): string {
  const status = getHttpStatus(error);
  if (status === undefined) {
    return 'auth.unableToConnect';
  }
  if (status === 422) {
    return 'settings.ssoUnlinkWouldStrand';
  }
  return getServerMessage(error) ?? 'settings.ssoDisconnectFailed';
}
