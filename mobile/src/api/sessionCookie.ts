import { isInsecureServerOrigin } from '@jot/shared';
import { LocalizedError } from '../i18n/utils';

const SESSION_COOKIE_NAME = 'jot_session';

/**
 * The server marked its session cookie `Secure`, but the response came over
 * plain HTTP. A browser would refuse to send that cookie back, so the app
 * refuses to store it (#1337): the operator's `JOT_COOKIE_SECURE` holds for
 * mobile as it does for the webapp.
 */
export class InsecureSessionCookieError extends LocalizedError {
  constructor() {
    super('auth.sessionRequiresHttps', 'The server only accepts its session over HTTPS.');
    this.name = 'InsecureSessionCookieError';
  }
}

interface ParsedSessionCookie {
  token: string;
  secure: boolean;
}

// React Native's networking layer can fold several Set-Cookie headers into one
// comma-joined string. A comma followed by `name=` starts the next cookie; the
// comma inside an `Expires=Wed, 21 Oct …` date is not.
const NEXT_COOKIE = /,\s*(?=[^\s;,=]+=)/;

/**
 * The `jot_session` cookie in a set of `Set-Cookie` values, with its `Secure`
 * attribute. An emptied `jot_session=` (a folded header can carry one ahead of
 * the real cookie) is skipped.
 */
export function parseSessionCookie(setCookieHeader: string | string[] | undefined): ParsedSessionCookie | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const cookie of headers.flatMap((header) => header.split(NEXT_COOKIE))) {
    const [pair = '', ...attributes] = cookie.split(';');
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const token = pair.slice(separator + 1).trim();
    if (!token) continue;
    const secure = attributes.some((attribute) => attribute.trim().toLowerCase() === 'secure');
    return { token, secure };
  }
  return null;
}

/**
 * The session token to store from a response received from `origin`, or null
 * when the response set none. Throws InsecureSessionCookieError when the
 * cookie is `Secure` and `origin` is plain HTTP off loopback. Browsers treat
 * loopback as a secure context and accept a `Secure` cookie there, so the app
 * does too.
 */
export function extractSessionCookie(setCookieHeader: string | string[] | undefined, origin: string): string | null {
  const parsed = parseSessionCookie(setCookieHeader);
  if (!parsed) return null;
  if (parsed.secure && isInsecureServerOrigin(origin)) {
    throw new InsecureSessionCookieError();
  }
  return parsed.token;
}
