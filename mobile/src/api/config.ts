import axios from 'axios';
import { apiPaths, apiUrl, canonicalizeServerOrigin, isInsecureServerOrigin, UPLOAD_MAX_BYTES, VALIDATION, type ServerConfig } from '@jot/shared';
import { REQUEST_ID_HEADER, echoesRequestId, newRequestId } from './jotResponse';

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  registration_enabled: true,
  password_min_length: VALIDATION.PASSWORD_MIN_LENGTH,
  upload_max_bytes: UPLOAD_MAX_BYTES,
};

/**
 * Whether `serverUrl` would hand out a session this app must refuse: a
 * `Secure` cookie over plain HTTP (#1337). Asked before logging in or
 * registering, because the server creates the account or session before the
 * app sees the cookie, and refusing it afterwards strands that account.
 *
 * Only a non-loopback http:// server is asked. When its config cannot be
 * read, or an older server does not report `cookie_secure`, this is false and
 * the check on the response (`extractSessionCookie`) is the backstop.
 */
export async function serverRequiresHttpsSession(serverUrl: string): Promise<boolean> {
  if (!isInsecureServerOrigin(serverUrl)) {
    return false;
  }
  const config = await probeServerConfig(serverUrl);
  return config?.cookie_secure === true;
}

// For a server that isn't the active one yet (mid server-setup or
// local-to-server upgrade flow, see ConnectToServerScreen): hits the given
// URL directly with a short timeout rather than going through the shared
// `api` client, which points at a different (or no) active server. Returns
// null on any failure — callers fall back to a cached or default value.
export async function probeServerConfig(serverUrl: string): Promise<ServerConfig | null> {
  const canonical = canonicalizeServerOrigin(serverUrl);
  if (!canonical) {
    return null;
  }
  try {
    const requestId = newRequestId();
    const res = await axios.get<ServerConfig>(apiUrl(apiPaths.config, canonical), {
      timeout: 5000,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
    // A captive portal's 200 page is not a config (#1266).
    return echoesRequestId(requestId, res.headers) ? res.data : null;
  } catch {
    return null;
  }
}
