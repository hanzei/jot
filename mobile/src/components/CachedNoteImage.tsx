import React from 'react';
import { Image, type ImageProps } from 'react-native';
import { useCachedNoteImageUri } from '../hooks/useNoteImageCache';
import { useImageAuthHeaders } from '../hooks/useImageAuthHeaders';
import type { NoteImageVariant } from '../utils/noteImageCache';

interface CachedNoteImageProps extends Omit<ImageProps, 'source'> {
  imageId: string;
  variant: NoteImageVariant;
  networkUrl: string;
}

// Renders a note image, preferring the local cache (populated in the
// background on a cache miss) over the network URL so a previously-viewed
// image keeps displaying with no network at all (issue #618). The image
// endpoint is auth-gated, so the network fallback attaches the session cookie
// explicitly (the native <Image> loader bypasses the axios interceptor and the
// app keeps no native cookie jar), and holds off loading until the token has
// resolved so the first render can't fire an unauthenticated 401.
export default function CachedNoteImage({ imageId, variant, networkUrl, ...imageProps }: CachedNoteImageProps) {
  const localUri = useCachedNoteImageUri(imageId, variant, networkUrl);
  const { headers, ready } = useImageAuthHeaders();

  if (localUri) {
    // A local file:// URI needs no auth.
    return <Image source={{ uri: localUri }} {...imageProps} />;
  }

  // Cache miss: fall back to the network URL, but only once auth is resolved.
  const source = ready ? { uri: networkUrl, headers } : undefined;
  return <Image source={source} {...imageProps} />;
}
