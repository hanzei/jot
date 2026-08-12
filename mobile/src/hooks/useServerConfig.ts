import { useEffect, useState } from 'react';
import type { ServerConfig } from '@jot/shared';
import { DEFAULT_SERVER_CONFIG, fetchServerConfig } from '../api/config';
import { getActiveServerId, getStoredServerUrl } from '../api/client';
import { getServerStorageValue, setServerStorageValue } from '../store/serverAccounts';

function parseCachedConfig(raw: string): ServerConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    if (
      typeof parsed.registration_enabled === 'boolean' &&
      typeof parsed.password_min_length === 'number' &&
      typeof parsed.upload_max_bytes === 'number'
    ) {
      return parsed as ServerConfig;
    }
  } catch {
    // Malformed cache entry — ignore and fall through to the default.
  }
  return null;
}

// The active server's public /config values (password_min_length,
// upload_max_bytes, registration_enabled). Never blocks: renders the cached
// or shared-default value immediately, then refreshes in the background — per
// the mobile connectivity rules, auth screens must not freeze on a network
// call, and there is no queue to fall back on for a GET.
export function useServerConfig(): ServerConfig {
  const [config, setConfig] = useState<ServerConfig>(DEFAULT_SERVER_CONFIG);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await getStoredServerUrl();
      const serverId = getActiveServerId();
      if (!serverId || cancelled) {
        return;
      }

      const cached = await getServerStorageValue(serverId, 'server_config').catch(() => null);
      if (cached && !cancelled) {
        const parsedConfig = parseCachedConfig(cached);
        if (parsedConfig) {
          setConfig(parsedConfig);
        }
      }

      try {
        const fresh = await fetchServerConfig();
        if (!cancelled) {
          setConfig(fresh);
          void setServerStorageValue(serverId, 'server_config', JSON.stringify(fresh));
        }
      } catch {
        // Server unreachable or the request failed — keep the cached/default value.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
