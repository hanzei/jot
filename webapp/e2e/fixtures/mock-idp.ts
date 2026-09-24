/**
 * A minimal OpenID Connect provider for the SSO-enabled e2e instance.
 *
 * Just enough of the authorization-code + PKCE flow for Jot's relying party
 * (`server/internal/oidc`, built on go-oidc and x/oauth2) to run its real code
 * path end to end: discovery, JWKS, an authorize page a test drives like a
 * human would, and a token endpoint that issues an RS256-signed ID token.
 * Nothing is persisted; the signing key and the pending codes live for one run.
 *
 * Playwright starts it as a `webServer` (see playwright.config.ts) with a plain
 * `node e2e/fixtures/mock-idp.ts`: Node runs it through built-in type stripping
 * (on by default from Node 22.18 / 23.6), so it uses erasable syntax only and
 * imports nothing but `node:` built-ins. The same module is imported by the
 * config and the spec for its constants; the server only starts when the file
 * is the process entry point.
 *
 * It is a test double, not a reference implementation: one client, one
 * redirect URI, no consent, no refresh tokens, no userinfo endpoint.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

export const MOCK_IDP_PORT = 8091;
/**
 * 127.0.0.1 rather than localhost on purpose: Jot runs on localhost, so the
 * redirect back to its callback is a cross-site navigation, as with a real IdP
 * — which is what the `SameSite=Lax` flow cookie has to survive.
 */
export const MOCK_IDP_ISSUER = `http://127.0.0.1:${MOCK_IDP_PORT}`;
export const MOCK_IDP_CLIENT_ID = 'jot-e2e';
export const MOCK_IDP_CLIENT_SECRET = 'jot-e2e-secret';
/** The one redirect URI registered for the client: the SSO Jot instance's callback. */
export const MOCK_IDP_REDIRECT_URI = 'http://localhost:8090/api/v1/auth/oidc/callback';
export const MOCK_IDP_READY_PATH = '/healthz';

/** The stable subject the IdP issues for an IdP username. */
export function mockIdpSubject(username: string): string {
  return `mock|${username}`;
}

const CODE_TTL_MS = 60_000;
const ID_TOKEN_TTL_S = 300;

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  username: string;
  expiresAt: number;
}

/** A validated authorization request: what the authorize page carries through to the decision. */
interface AuthorizeRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function startMockIdp(): void {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = base64url(randomBytes(8));
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] };
  const codes = new Map<string, PendingCode>();

  function signIdToken(claims: Record<string, unknown>): string {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = base64url(JSON.stringify(claims));
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function sendText(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  function redirect(res: ServerResponse, target: string, params: Record<string, string>): void {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    res.writeHead(302, { Location: url.toString() });
    res.end();
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * Validates the client and redirect URI before anything else, as a real IdP
   * must: an unregistered redirect_uri gets an error page, never a redirect.
   */
  function parseAuthorizeRequest(params: URLSearchParams): AuthorizeRequest | string {
    if (params.get('client_id') !== MOCK_IDP_CLIENT_ID) {
      return 'unknown client_id';
    }
    if (params.get('redirect_uri') !== MOCK_IDP_REDIRECT_URI) {
      return 'redirect_uri does not match the registered one';
    }
    if (params.get('response_type') !== 'code') {
      return 'unsupported response_type';
    }
    if (!(params.get('scope') ?? '').split(' ').includes('openid')) {
      return 'scope must include openid';
    }
    const codeChallenge = params.get('code_challenge') ?? '';
    if (codeChallenge && params.get('code_challenge_method') !== 'S256') {
      return 'only the S256 code_challenge_method is supported';
    }
    return {
      redirectUri: MOCK_IDP_REDIRECT_URI,
      state: params.get('state') ?? '',
      nonce: params.get('nonce') ?? '',
      codeChallenge,
    };
  }

  function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  }

  function renderAuthorizePage(res: ServerResponse, params: URLSearchParams): void {
    // Every authorization parameter rides along as a hidden field, so the POST
    // re-validates exactly what the GET did rather than trusting a session.
    const hidden = [...params.entries()]
      .map((entry) => `<input type="hidden" name="${escapeHtml(entry[0])}" value="${escapeHtml(entry[1])}">`)
      .join('\n      ');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock IdP — Sign in</title></head>
<body>
  <main>
    <h1>Mock IdP</h1>
    <form method="post" action="/authorize">
      ${hidden}
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="off" required>
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
    </form>
  </main>
</body>
</html>`);
  }

  function handleAuthorizeDecision(res: ServerResponse, form: URLSearchParams): void {
    const request = parseAuthorizeRequest(form);
    if (typeof request === 'string') {
      sendText(res, 400, request);
      return;
    }
    if (form.get('decision') !== 'approve') {
      redirect(res, request.redirectUri, { error: 'access_denied', state: request.state });
      return;
    }
    const username = (form.get('username') ?? '').trim();
    if (!username) {
      sendText(res, 400, 'username is required');
      return;
    }
    const code = base64url(randomBytes(24));
    codes.set(code, {
      clientId: MOCK_IDP_CLIENT_ID,
      redirectUri: request.redirectUri,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
      username,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    redirect(res, request.redirectUri, { code, state: request.state });
  }

  function secretMatches(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(MOCK_IDP_CLIENT_SECRET);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Accepts both client_secret_basic and client_secret_post. x/oauth2
   * auto-detects the style — it tries the Authorization header first and only
   * retries with body parameters if that is rejected — so both must work.
   */
  function authenticateClient(req: IncomingMessage, form: URLSearchParams): boolean {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) {
        return false;
      }
      // RFC 6749 §2.3.1: both halves are form-urlencoded before being joined.
      const id = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' '));
      const secret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' '));
      return id === MOCK_IDP_CLIENT_ID && secretMatches(secret);
    }
    return form.get('client_id') === MOCK_IDP_CLIENT_ID && secretMatches(form.get('client_secret') ?? '');
  }

  function handleToken(req: IncomingMessage, res: ServerResponse, form: URLSearchParams): void {
    if (!authenticateClient(req, form)) {
      sendJson(res, 401, { error: 'invalid_client' });
      return;
    }
    if (form.get('grant_type') !== 'authorization_code') {
      sendJson(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    // Single use: a code is spent by its first exchange attempt, good or bad.
    codes.delete(code);
    if (!pending || pending.expiresAt < Date.now() || pending.clientId !== MOCK_IDP_CLIENT_ID) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown, expired or used code' });
      return;
    }
    if (form.get('redirect_uri') !== pending.redirectUri) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    if (pending.codeChallenge) {
      const verifier = form.get('code_verifier') ?? '';
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      if (!verifier || challenge !== pending.codeChallenge) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const idToken = signIdToken({
      iss: MOCK_IDP_ISSUER,
      aud: MOCK_IDP_CLIENT_ID,
      sub: mockIdpSubject(pending.username),
      nonce: pending.nonce,
      iat: now,
      exp: now + ID_TOKEN_TTL_S,
      preferred_username: pending.username,
      email: `${pending.username}@mock-idp.test`,
    });
    sendJson(res, 200, {
      access_token: base64url(randomBytes(24)),
      token_type: 'Bearer',
      expires_in: ID_TOKEN_TTL_S,
      id_token: idToken,
    });
  }

  const discovery = {
    issuer: MOCK_IDP_ISSUER,
    authorization_endpoint: `${MOCK_IDP_ISSUER}/authorize`,
    token_endpoint: `${MOCK_IDP_ISSUER}/token`,
    jwks_uri: `${MOCK_IDP_ISSUER}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code'],
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', MOCK_IDP_ISSUER);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    switch (route) {
      case `GET ${MOCK_IDP_READY_PATH}`:
        sendText(res, 200, 'ok');
        return;
      case 'GET /.well-known/openid-configuration':
        sendJson(res, 200, discovery);
        return;
      case 'GET /jwks':
        sendJson(res, 200, jwks);
        return;
      case 'GET /authorize': {
        const request = parseAuthorizeRequest(url.searchParams);
        if (typeof request === 'string') {
          sendText(res, 400, request);
          return;
        }
        renderAuthorizePage(res, url.searchParams);
        return;
      }
      case 'POST /authorize':
        handleAuthorizeDecision(res, await readForm(req));
        return;
      case 'POST /token':
        handleToken(req, res, await readForm(req));
        return;
      default:
        sendText(res, 404, 'not found');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('mock-idp: request failed', err);
      if (!res.headersSent) {
        sendText(res, 500, 'internal error');
      } else {
        res.end();
      }
    });
  });
  server.listen(MOCK_IDP_PORT, '127.0.0.1', () => {
    console.log(`mock-idp: listening on ${MOCK_IDP_ISSUER}`);
  });
}

// argv[1] keeps any symlink in the path while import.meta.url is the resolved
// real path, so compare real paths or a symlinked checkout never starts.
const entryPoint = process.argv[1];
if (entryPoint && realpathSync(entryPoint) === fileURLToPath(import.meta.url)) {
  startMockIdp();
}
