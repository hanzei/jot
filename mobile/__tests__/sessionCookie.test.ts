import { InsecureSessionCookieError, extractSessionCookie, parseSessionCookie } from '../src/api/sessionCookie';

describe('parseSessionCookie', () => {
  it('reads the token and no Secure attribute', () => {
    expect(parseSessionCookie(['jot_session=abc123; Path=/; HttpOnly; SameSite=Lax'])).toEqual({ token: 'abc123', secure: false });
  });

  it('reads the Secure attribute in any case and position', () => {
    expect(parseSessionCookie('jot_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax')).toEqual({ token: 'abc', secure: true });
    expect(parseSessionCookie('jot_session=abc;secure')).toEqual({ token: 'abc', secure: true });
  });

  it('finds jot_session among other cookies', () => {
    expect(parseSessionCookie(['other=1; Secure', 'jot_session=tok; Path=/'])).toEqual({ token: 'tok', secure: false });
  });

  it('does not take another cookie\'s attributes in a comma-joined header', () => {
    const joined = 'jot_session=tok; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly, other=1; Path=/; Secure';
    expect(parseSessionCookie(joined)).toEqual({ token: 'tok', secure: false });
  });

  it('reads jot_session when it is not first in a comma-joined header', () => {
    expect(parseSessionCookie('other=1; Path=/, jot_session=tok; Path=/; Secure')).toEqual({ token: 'tok', secure: true });
  });

  it('skips an emptied jot_session ahead of the real one in a comma-joined header', () => {
    expect(parseSessionCookie('jot_session=; Max-Age=0, jot_session=tok; Path=/; Secure')).toEqual({ token: 'tok', secure: true });
  });

  it('ignores a cookie whose name merely ends in jot_session', () => {
    expect(parseSessionCookie('old_jot_session=x; Path=/')).toBeNull();
  });

  it('returns null without a session cookie', () => {
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie([])).toBeNull();
    expect(parseSessionCookie('other=1')).toBeNull();
    expect(parseSessionCookie('jot_session=; Path=/')).toBeNull();
  });
});

describe('extractSessionCookie', () => {
  it('refuses a Secure cookie received over plain HTTP', () => {
    expect(() => extractSessionCookie('jot_session=tok; Secure', 'http://jot.lan:8080')).toThrow(InsecureSessionCookieError);
  });

  it('accepts a Secure cookie over loopback HTTP, as browsers do', () => {
    expect(extractSessionCookie('jot_session=tok; Secure', 'http://localhost:8080')).toBe('tok');
    expect(extractSessionCookie('jot_session=tok; Secure', 'http://127.0.0.1:8080')).toBe('tok');
  });

  it('accepts a Secure cookie over HTTPS', () => {
    expect(extractSessionCookie('jot_session=tok; Secure', 'https://jot.example.com')).toBe('tok');
  });

  it('accepts a cookie without Secure over plain HTTP (JOT_COOKIE_SECURE=false)', () => {
    expect(extractSessionCookie('jot_session=tok; Path=/; HttpOnly', 'http://jot.lan:8080')).toBe('tok');
  });

  it('returns null when the response set no session', () => {
    expect(extractSessionCookie(undefined, 'http://jot.lan:8080')).toBeNull();
  });
});
