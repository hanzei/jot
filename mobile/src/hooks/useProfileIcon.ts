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
  // The resolved URI is stored with the inputs it was resolved for, so a URI
  // left over from a previous icon is discarded during render. Clearing it in
  // the effect instead would paint the old icon for one frame after the inputs
  // change.
  const iconKey = `${userId ?? ''} ${iconVersion ?? ''} ${networkUrl}`;
  const [resolved, setResolved] = useState<{ key: string; uri: string } | null>(null);
  const localUri = resolved !== null && resolved.key === iconKey ? resolved.uri : null;

  useEffect(() => {
    if (!hasProfileIcon || !userId || !iconVersion || !networkUrl) return;

    let cancelled = false;

    async function load() {
      const cached = await getCachedIconUri(userId!, iconVersion!);
      if (cancelled) return;
      if (cached) {
        setResolved({ key: iconKey, uri: cached });
        return;
      }
      // Cache miss — display network URL, download in background.
      const downloaded = await downloadAndCacheIcon(userId!, iconVersion!, networkUrl);
      if (!cancelled && downloaded) {
        setResolved({ key: iconKey, uri: downloaded });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, hasProfileIcon, iconVersion, networkUrl, iconKey]);

  return localUri;
}
