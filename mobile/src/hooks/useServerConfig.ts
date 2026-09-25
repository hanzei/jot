import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig, SSOConfig } from '@jot/shared';
import { DEFAULT_SERVER_CONFIG, fetchServerConfig } from '../api/config';
import { getActiveServerId, getStoredServerUrl, subscribeToClientActiveServerChanges } from '../api/client';
import { getServerStorageValue, setServerStorageValue } from '../store/serverAccounts';
import { serverConfigQueryKey } from './queryKeys';

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

async function loadCachedServerConfig(serverId: string): Promise<ServerConfig> {
  const cached = await getServerStorageValue(serverId, 'server_config').catch(() => null);
  if (!cached) {
    return DEFAULT_SERVER_CONFIG;
  }
  return parseCachedConfig(cached) ?? DEFAULT_SERVER_CONFIG;
}

// The active server's public /config values (password_min_length,
// upload_max_bytes, registration_enabled, sso). Never blocks: renders the
// cached or shared-default value immediately, then refreshes in the
// background — per the mobile connectivity rules, auth screens must not freeze
// on a network call, and there is no queue to fall back on for a GET. Reloads
// when the active server changes, so the login screen's SSO button follows the
// server picker.
//
// Keyed by server id and backed by a React Query query (rather than a bare
// effect per caller), so mounting several callers for the same server — e.g.
// Settings' ChangePasswordSection and SsoSection — collapses into one
// `/config` request instead of one per caller (#1017).
export function useServerConfig(): ServerConfig {
  const queryClient = useQueryClient();
  const [serverId, setServerId] = useState<string | null>(() => getActiveServerId());

  useEffect(() => {
    let cancelled = false;

    void getStoredServerUrl().then(() => {
      if (!cancelled) {
        setServerId(getActiveServerId());
      }
    });

    const unsubscribe = subscribeToClientActiveServerChanges((id) => {
      if (!cancelled) {
        setServerId(id);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const queryKey = serverConfigQueryKey(serverId);
  const query = useQuery<ServerConfig>({
    queryKey,
    queryFn: async () => {
      if (!serverId) {
        return DEFAULT_SERVER_CONFIG;
      }

      const cached = await loadCachedServerConfig(serverId);
      // Publish the cached value right away so every observer of this query
      // (all callers for this server) renders it while the network call below
      // is still in flight, rather than staying on the previous/default value.
      queryClient.setQueryData(queryKey, cached);

      try {
        const fresh = await fetchServerConfig();
        setServerStorageValue(serverId, 'server_config', JSON.stringify(fresh)).catch(() => {
          // Best-effort cache write — a SecureStore failure shouldn't surface here.
        });
        return fresh;
      } catch {
        // Server unreachable or the request failed — keep the cached/default value.
        return cached;
      }
    },
  });

  return query.data ?? DEFAULT_SERVER_CONFIG;
}
