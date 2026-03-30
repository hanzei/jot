import { useState, useEffect } from 'react';
import { getBaseUrl, getStoredServerUrl } from '../api/client';
import { canonicalizeServerOrigin } from '@jot/shared';

export function validateServerUrl(url: string): string | null {
  if (!url.trim()) return 'auth.serverUrlRequired';
  if (!canonicalizeServerOrigin(url)) return 'auth.serverUrlProtocol';
  return null;
}

export function useServerUrl() {
  const [serverUrl, setServerUrlState] = useState(getBaseUrl);

  useEffect(() => {
    getStoredServerUrl()
      .then((stored) => setServerUrlState(stored ?? getBaseUrl()))
      .catch(() => setServerUrlState(getBaseUrl()));
  }, []);

  return { serverUrl, setServerUrl: setServerUrlState, validateServerUrl };
}
