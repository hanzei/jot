import React, { useState } from 'react';
import { View, Image, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NoteImage } from '@jot/shared';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';
import { noteImageThumbnailUrl } from '../api/images';
import ImageLightbox from './ImageLightbox';

interface NoteImageGalleryProps {
  images: NoteImage[];
}

// Grid tiles shown at once; beyond this the last tile carries a "+N" overlay
// for the rest instead of growing the grid further. Mirrors the webapp rule
// (NoteImageGallery.tsx) so the two clients agree on how a note's images fold.
const GRID_VISIBLE_TILES = 4;
const GRID_CLEAR_TILES = GRID_VISIBLE_TILES - 1;
const BANNER_MAX_HEIGHT = 240;

// Read-only display of a note's images: a full-width banner for a single
// image, or a responsive 2-column grid for 2+ (laid out from width/height so
// the reserved space roughly matches the image before it loads). Tapping a
// tile opens the full-screen swipeable lightbox at that image's index.
export default function NoteImageGallery({ images }: NoteImageGalleryProps) {
  const { t } = useTranslation();
  const baseUrl = useActiveServerBaseUrl();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (images.length === 0) return null;

  const isGrid = images.length > 1;
  const visibleCount = Math.min(images.length, GRID_VISIBLE_TILES);
  const overlayCount = images.length > GRID_VISIBLE_TILES ? images.length - GRID_CLEAR_TILES : 0;
  const visibleImages = images.slice(0, visibleCount);
  // An odd tile count of 3 spans the final tile across both columns so it
  // doesn't leave a dangling empty cell.
  const spanLastTile = isGrid && visibleCount === 3;

  const renderTile = (image: NoteImage, index: number) => {
    const isOverlayTile = overlayCount > 0 && index === visibleCount - 1;
    const label = isOverlayTile
      ? t('images.moreImages', { count: overlayCount })
      : t('images.openLightbox', { filename: image.filename });
    const aspectRatio = image.width && image.height ? image.width / image.height : 4 / 3;

    return (
      <TouchableOpacity
        key={image.id}
        style={[
          isGrid ? styles.gridTile : [styles.bannerTile, { aspectRatio }],
          spanLastTile && index === 2 ? styles.spanTwoColumns : null,
        ]}
        onPress={() => setLightboxIndex(index)}
        accessibilityLabel={label}
        accessibilityRole="button"
        testID={isGrid ? `note-image-grid-tile-${image.id}` : `note-image-banner-${image.id}`}
      >
        <Image
          source={{ uri: noteImageThumbnailUrl(baseUrl, image.id) }}
          style={styles.tileImage}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
        {isOverlayTile && (
          <View style={styles.overlay} testID={`note-image-overlay-${image.id}`}>
            <Text style={styles.overlayText}>+{overlayCount}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <>
      {isGrid ? (
        <View style={styles.grid} testID="note-image-grid">
          {visibleImages.map((image, i) => renderTile(image, i))}
        </View>
      ) : (
        <View testID="note-image-banner-container">{renderTile(visibleImages[0], 0)}</View>
      )}
      <ImageLightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  gridTile: {
    flexBasis: '48%',
    flexGrow: 1,
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb',
  },
  spanTwoColumns: {
    flexBasis: '100%',
  },
  bannerTile: {
    width: '100%',
    maxHeight: BANNER_MAX_HEIGHT,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 12,
    backgroundColor: '#e5e7eb',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlayText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});
