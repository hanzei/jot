import { useState, useEffect } from 'react';
import { getCachedIconUri, downloadAndCacheIcon } from '../utils/profileIconCache';

// Returns the best available URI for a user's profile icon:
// local cache if available, otherwise null (caller falls back to network URL or initials).
// Triggers a background download when the cache is cold.
export function useProfileIcon(
  userId: string | undefined,
  hasProfileIcon: boolean,
  iconVersion: string | undefined,
  networkUrl: string,
): string | null {
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing, tracked in #777
    setLocalUri(null);
    if (!hasProfileIcon || !userId || !iconVersion || !networkUrl) return;

    let cancelled = false;

    async function load() {
      const cached = await getCachedIconUri(userId!, iconVersion!);
      if (cancelled) return;
      if (cached) {
        setLocalUri(cached);
        return;
      }
      // Cache miss — display network URL, download in background.
      const downloaded = await downloadAndCacheIcon(userId!, iconVersion!, networkUrl);
      if (!cancelled && downloaded) {
        setLocalUri(downloaded);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, hasProfileIcon, iconVersion, networkUrl]);

  return localUri;
}
