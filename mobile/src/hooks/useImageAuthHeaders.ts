import { useEffect, useState } from 'react';
import { getSessionCookieHeader, subscribeToClientActiveServerChanges } from '../api/client';

export interface ImageAuthHeaders {
  /** The `Cookie` header to attach to a network image request, or undefined when there is no session. */
  headers?: Record<string, string>;
  /**
   * False until the session token has been resolved. Callers should hold off
   * loading a network image URL until this is true, otherwise the first render
   * fires an unauthenticated request that 401s (and, for an <Image> with an
   * onError fallback, poisons it into its error state before the header arrives).
   */
  ready: boolean;
}

// Resolves the auth headers needed to load an auth-gated image (note image or
// profile icon) with the native <Image> loader, which bypasses the axios
// interceptor that would otherwise attach the session cookie. Re-resolves on a
// server switch so a switched-to account's session is used.
export function useImageAuthHeaders(): ImageAuthHeaders {
  const [state, setState] = useState<ImageAuthHeaders>({ ready: false });

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      getSessionCookieHeader()
        .then((headers) => {
          if (!cancelled) setState({ headers, ready: true });
        })
        .catch(() => {
          if (!cancelled) setState({ ready: true });
        });
    };

    load();
    const unsubscribe = subscribeToClientActiveServerChanges(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
