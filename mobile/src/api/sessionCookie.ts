const SESSION_COOKIE_NAME = 'jot_session';
const HTTP_PROTOCOL = 'http:';

/**
 * The server marked its session cookie `Secure`, but the response came over
 * plain HTTP. A browser would refuse to send that cookie back, so the app
 * refuses to store it (#1337): the operator's `JOT_COOKIE_SECURE` holds for
 * mobile as it does for the webapp.
 */
export class InsecureSessionCookieError extends Error {
  constructor() {
    super('The server only accepts its session over HTTPS.');
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
const SESSION_COOKIE_START = new RegExp(`(?:^|[,;]\\s*)(${SESSION_COOKIE_NAME}=)`);

/** The `jot_session` cookie in a set of `Set-Cookie` values, with its `Secure` attribute. */
export function parseSessionCookie(setCookieHeader: string | string[] | undefined): ParsedSessionCookie | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const match = SESSION_COOKIE_START.exec(header);
    if (!match) continue;
    const fromName = header.slice(match.index + match[0].length - SESSION_COOKIE_NAME.length - 1);
    const end = fromName.search(NEXT_COOKIE);
    const cookie = end === -1 ? fromName : fromName.slice(0, end);
    const [pair = '', ...attributes] = cookie.split(';');
    const token = pair.slice(SESSION_COOKIE_NAME.length + 1).trim();
    if (!token) continue;
    const secure = attributes.some((attribute) => attribute.trim().toLowerCase() === 'secure');
    return { token, secure };
  }
  return null;
}

/**
 * The session token to store from a response received from `origin`, or null
 * when the response set none. Throws InsecureSessionCookieError when the
 * cookie is `Secure` and `origin` is plain HTTP.
 */
export function extractSessionCookie(setCookieHeader: string | string[] | undefined, origin: string): string | null {
  const parsed = parseSessionCookie(setCookieHeader);
  if (!parsed) return null;
  if (parsed.secure && isPlainHttp(origin)) {
    throw new InsecureSessionCookieError();
  }
  return parsed.token;
}

function isPlainHttp(origin: string): boolean {
  try {
    return new URL(origin).protocol === HTTP_PROTOCOL;
  } catch {
    return false;
  }
}
