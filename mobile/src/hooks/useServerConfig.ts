import { useEffect, useState } from 'react';
import type { ServerConfig, SSOConfig } from '@jot/shared';
import { DEFAULT_SERVER_CONFIG, fetchServerConfig } from '../api/config';
import { getActiveServerId, getStoredServerUrl, subscribeToClientActiveServerChanges } from '../api/client';
import { getServerStorageValue, setServerStorageValue } from '../store/serverAccounts';

function parseSsoConfig(value: unknown): SSOConfig | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const sso = value as Partial<SSOConfig>;
  if (
    typeof sso.enabled === 'boolean' &&
    typeof sso.provider_name === 'string' &&
    typeof sso.local_login_enabled === 'boolean'
  ) {
    return { enabled: sso.enabled, provider_name: sso.provider_name, local_login_enabled: sso.local_login_enabled };
  }
  return undefined;
}

export function parseCachedConfig(raw: string): ServerConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    if (
      typeof parsed.registration_enabled === 'boolean' &&
      typeof parsed.password_min_length === 'number' &&
      typeof parsed.upload_max_bytes === 'number'
    ) {
      const config: ServerConfig = {
        registration_enabled: parsed.registration_enabled,
        password_min_length: parsed.password_min_length,
        upload_max_bytes: parsed.upload_max_bytes,
      };
      // A missing or malformed `sso` (a pre-SSO server's cache) reads as SSO
      // off rather than invalidating the rest of the entry.
      const sso = parseSsoConfig(parsed.sso);
      if (sso) {
        config.sso = sso;
      }
      return config;
    }
  } catch {
    // Malformed cache entry — ignore and fall through to the default.
  }
  return null;
}

// The active server's public /config values (password_min_length,
// upload_max_bytes, registration_enabled, sso). Never blocks: renders the
// cached or shared-default value immediately, then refreshes in the
// background — per the mobile connectivity rules, auth screens must not freeze
// on a network call, and there is no queue to fall back on for a GET. Reloads
// when the active server changes, so the login screen's SSO button follows the
// server picker.
export function useServerConfig(): ServerConfig {
  const [config, setConfig] = useState<ServerConfig>(DEFAULT_SERVER_CONFIG);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let loadedServerId: string | null = null;

    const load = async () => {
      const current = ++generation;
      const isStale = () => cancelled || current !== generation;

      await getStoredServerUrl();
      const serverId = getActiveServerId();
      if (isStale()) {
        return;
      }
      if (serverId !== loadedServerId) {
        // Another server's values must not linger while this one loads.
        loadedServerId = serverId;
        setConfig(DEFAULT_SERVER_CONFIG);
      }
      if (!serverId) {
        return;
      }

      const cached = await getServerStorageValue(serverId, 'server_config').catch(() => null);
      if (cached && !isStale()) {
        const parsedConfig = parseCachedConfig(cached);
        if (parsedConfig) {
          setConfig(parsedConfig);
        }
      }

      try {
        const fresh = await fetchServerConfig();
        if (!isStale()) {
          setConfig(fresh);
          setServerStorageValue(serverId, 'server_config', JSON.stringify(fresh)).catch(() => {
            // Best-effort cache write — a SecureStore failure shouldn't surface here.
          });
        }
      } catch {
        // Server unreachable or the request failed — keep the cached/default value.
      }
    };

    void load().catch(() => undefined);
    const unsubscribe = subscribeToClientActiveServerChanges(() => {
      void load().catch(() => undefined);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return config;
}
