import { useEffect, useState } from 'react';
import { getBaseUrl, subscribeToClientActiveServerChanges } from '../api/client';

export function useActiveServerBaseUrl(): string {
  const [baseUrl, setBaseUrl] = useState<string>(() => getBaseUrl());

  useEffect(() => {
    const unsubscribe = subscribeToClientActiveServerChanges(() => {
      setBaseUrl(getBaseUrl());
    });

    return unsubscribe;
  }, []);

  return baseUrl;
}
