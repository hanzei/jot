import { useEffect, useState } from 'react';
import type { AboutInfo } from '@jot/shared';
import { about } from '@/utils/api';

// Fetched at most once per page load, however often a caller mounts. A failed
// fetch is dropped so the next mount can try again.
let serverInfoRequest: Promise<AboutInfo | null> | null = null;

/**
 * Best-effort server build info for the copied diagnostics reports, or null
 * until (or unless) it loads. Fetched on mount rather than on click: an await
 * before the clipboard write can cost the user activation it needs. Skips the
 * 401 redirect, which would replace the error fallback the user is reading.
 */
export function useServerInfo(): AboutInfo | null {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    serverInfoRequest ??= about.get({ skipAuthRedirect: true })
      .catch(() => {
        serverInfoRequest = null;
        return null;
      });
    void serverInfoRequest.then((v) => { if (!cancelled) setInfo(v); });
    return () => { cancelled = true; };
  }, []);
  return info;
}
