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

export function createServerId(canonicalServerOrigin: string): string {
  // FNV-1a 32-bit hash for deterministic, short server IDs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonicalServerOrigin.length; i += 1) {
    hash ^= canonicalServerOrigin.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `srv_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
