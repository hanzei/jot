import { useState, useEffect } from 'react';
import { getCachedNoteImageUri, downloadAndCacheNoteImage, type NoteImageVariant } from '../utils/noteImageCache';

// Returns the best available URI for a note image (a gallery tile's thumbnail,
// or the lightbox's original): local cache if available, otherwise null (the
// caller falls back to the network URL, which works when online and is a
// no-op/broken-image otherwise). Triggers a background download to warm the
// cache when it's cold, so the next view (including fully offline) is served
// locally (issue #618).
export function useCachedNoteImageUri(
  imageId: string,
  variant: NoteImageVariant,
  networkUrl: string,
): string | null {
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    // Grandfathered: drops the previous URI before the async cache lookup resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalUri(null);
    if (!imageId || !networkUrl) return;

    let cancelled = false;

    async function load() {
      const cached = await getCachedNoteImageUri(imageId, variant);
      if (cancelled) return;
      if (cached) {
        setLocalUri(cached);
        return;
      }
      // Cache miss — display the network URL in the meantime, download in background.
      const downloaded = await downloadAndCacheNoteImage(imageId, variant, networkUrl);
      if (!cancelled && downloaded) {
        setLocalUri(downloaded);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [imageId, variant, networkUrl]);

  return localUri;
}
