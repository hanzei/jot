/**
 * Post-login redirect targets.
 *
 * A protected route that bounces an unauthenticated visitor to /login stashes
 * where they were headed in a `continue` query parameter, and the auth pages
 * send them there once they are signed in.
 *
 * That parameter is attacker-controllable — it sits in a URL anyone can craft
 * and mail around — so a target is validated both when it is written into the
 * login link and when it is read back out. Only same-origin absolute paths
 * survive; anything else silently falls back to the dashboard.
 */

export const REDIRECT_PARAM = 'continue';

const DEFAULT_TARGET = '/';

/** Redirecting back to an auth page would just bounce the user around. */
const AUTH_PATHS = ['/login', '/register'];

/**
 * Origin used only to resolve the target for validation. Its value never
 * reaches the browser — it is compared against and then discarded.
 */
const PROBE_ORIGIN = 'https://jot.invalid';

/** Sanitize a redirect target, falling back to the dashboard. */
export function safeRedirectTarget(target: string | null | undefined): string {
  if (!target || !target.startsWith('/')) {
    return DEFAULT_TARGET;
  }

  let url: URL;
  try {
    url = new URL(target, PROBE_ORIGIN);
  } catch {
    return DEFAULT_TARGET;
  }

  // A leading slash alone does not make a target same-origin: both
  // "//evil.com" and "/\evil.com" parse as protocol-relative URLs.
  if (url.origin !== PROBE_ORIGIN || AUTH_PATHS.includes(url.pathname)) {
    return DEFAULT_TARGET;
  }

  return url.pathname + url.search + url.hash;
}

/**
 * Build a link to `authPath` (/login or /register) that remembers where the
 * user was headed. The parameter is omitted for the dashboard, which is where
 * the auth pages land by default anyway.
 */
export function authPathWithRedirect(authPath: string, target: string | null | undefined): string {
  const safeTarget = safeRedirectTarget(target);
  if (safeTarget === DEFAULT_TARGET) {
    return authPath;
  }
  return `${authPath}?${REDIRECT_PARAM}=${encodeURIComponent(safeTarget)}`;
}

/** The current browser location, in the form a redirect target takes. */
export function currentRedirectTarget(): string {
  const { pathname, search, hash } = window.location;
  return pathname + search + hash;
}
