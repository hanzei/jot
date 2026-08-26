import axios from 'axios';
import { canonicalizeServerOrigin, UPLOAD_MAX_BYTES, VALIDATION, type ServerConfig } from '@jot/shared';
import api from './client';

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  registration_enabled: true,
  password_min_length: VALIDATION.PASSWORD_MIN_LENGTH,
  upload_max_bytes: UPLOAD_MAX_BYTES,
};

// GET /config is public (no auth required), so this rides the shared `api`
// client and its active-server base URL like any other read.
export async function fetchServerConfig(): Promise<ServerConfig> {
  const res = await api.get<ServerConfig>('/config');
  return res.data;
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
    const res = await axios.get<ServerConfig>(`${canonical}/api/v1/config`, { timeout: 5000 });
    return res.data;
  } catch {
    return null;
  }
}
