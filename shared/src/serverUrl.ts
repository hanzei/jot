const HTTP_PROTOCOL = 'http:';
const HTTPS_PROTOCOL = 'https:';

export function canonicalizeServerOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== HTTP_PROTOCOL && protocol !== HTTPS_PROTOCOL) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return null;
  }

  const isDefaultHttpPort = protocol === HTTP_PROTOCOL && parsed.port === '80';
  const isDefaultHttpsPort = protocol === HTTPS_PROTOCOL && parsed.port === '443';
  const normalizedPort = parsed.port && !isDefaultHttpPort && !isDefaultHttpsPort ? `:${parsed.port}` : '';

  return `${protocol}//${hostname}${normalizedPort}`;
}

/**
 * Hosts that never leave the device, so plain HTTP to them crosses no network.
 * `10.0.2.2` (the Android emulator's host alias) is deliberately absent: it is
 * also an ordinary LAN address.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether talking to this server sends passwords, the session and note content
 * unencrypted over a network: an `http:` origin on anything but loopback. An
 * input that is not a valid server URL is not insecure, just invalid.
 */
export function isInsecureServerOrigin(input: string): boolean {
  const canonical = canonicalizeServerOrigin(input);
  if (!canonical) {
    return false;
  }
  const { protocol, hostname } = new URL(canonical);
  return protocol === HTTP_PROTOCOL && !LOOPBACK_HOSTNAMES.has(hostname);
}

export function createServerId(canonicalServerOrigin: string): string {
  // FNV-1a 32-bit hash for deterministic, short server IDs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonicalServerOrigin.length; i += 1) {
    hash ^= canonicalServerOrigin.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `srv_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
