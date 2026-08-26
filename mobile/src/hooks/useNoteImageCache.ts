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
  // The resolved URI is stored with the inputs it was resolved for, so a URI
  // left over from a previous image is discarded during render. Clearing it in
  // the effect instead would paint the old image for one frame after the inputs
  // change.
  const imageKey = `${imageId} ${variant} ${networkUrl}`;
  const [resolved, setResolved] = useState<{ key: string; uri: string } | null>(null);
  const localUri = resolved !== null && resolved.key === imageKey ? resolved.uri : null;

  useEffect(() => {
    if (!imageId || !networkUrl) return;

    let cancelled = false;

    async function load() {
      const cached = await getCachedNoteImageUri(imageId, variant);
      if (cancelled) return;
      if (cached) {
        setResolved({ key: imageKey, uri: cached });
        return;
      }
      // Cache miss — display the network URL in the meantime, download in background.
      const downloaded = await downloadAndCacheNoteImage(imageId, variant, networkUrl);
      if (!cancelled && downloaded) {
        setResolved({ key: imageKey, uri: downloaded });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [imageId, variant, networkUrl, imageKey]);

  return localUri;
}
