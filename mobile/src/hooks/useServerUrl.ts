import { useState, useEffect } from 'react';
import { getBaseUrl, getStoredServerUrl } from '../api/client';

export function validateServerUrl(url: string): string | null {
  if (!url.trim()) return 'Server URL is required';
  if (!/^https?:\/\/.+/.test(url.trim())) return 'Server URL must start with http:// or https://';
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
