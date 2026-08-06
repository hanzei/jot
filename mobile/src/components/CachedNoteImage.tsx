import { Image, type ImageProps } from 'react-native';
import { useCachedNoteImageUri } from '../hooks/useNoteImageCache';
import type { NoteImageVariant } from '../utils/noteImageCache';

interface CachedNoteImageProps extends Omit<ImageProps, 'source'> {
  imageId: string;
  variant: NoteImageVariant;
  networkUrl: string;
}

// Renders a note image, preferring the local cache (populated in the
// background on a cache miss) over the network URL so a previously-viewed
// image keeps displaying with no network at all (issue #618).
export default function CachedNoteImage({ imageId, variant, networkUrl, ...imageProps }: CachedNoteImageProps) {
  const localUri = useCachedNoteImageUri(imageId, variant, networkUrl);
  return <Image source={{ uri: localUri ?? networkUrl }} {...imageProps} />;
}
