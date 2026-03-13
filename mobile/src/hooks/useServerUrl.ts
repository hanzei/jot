import { useState, useEffect } from 'react';
import { getBaseUrl, getStoredServerUrl } from '../api/client';

export function useServerUrl() {
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    getStoredServerUrl()
      .then((stored) => setServerUrl(stored ?? getBaseUrl()))
      .catch(() => setServerUrl(getBaseUrl()));
  }, []);

  function validateServerUrl(url: string): string | null {
    if (!url.trim()) return 'Server URL is required';
    if (!/^https?:\/\/.+/.test(url.trim())) return 'Server URL must start with http:// or https://';
    return null;
  }

  return { serverUrl, setServerUrl, validateServerUrl };
}
