import React, { useState } from 'react';
import { View, Image, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { NoteImage } from '@jot/shared';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';
import { noteImageThumbnailUrl } from '../api/images';
import CachedNoteImage from './CachedNoteImage';
import ImageLightbox from './ImageLightbox';
import type { PendingImageUpload } from '../hooks/usePendingImageUploads';

export type { PendingImageUpload };

interface NoteImageGalleryProps {
  images: NoteImage[];
  // Adding editable=true turns on a remove button for persisted images and
  // renders `uploads` as in-progress/error tiles. Read-only callers can omit
  // it and get the original display-only gallery.
  editable?: boolean;
  uploads?: PendingImageUpload[];
  onRemove?: (image: NoteImage) => void;
  onRetryUpload?: (uploadId: string) => void;
  onDismissUpload?: (uploadId: string) => void;
}

type Tile =
  | { key: string; kind: 'image'; image: NoteImage }
  | { key: string; kind: 'upload'; upload: PendingImageUpload };

// Grid tiles shown at once; beyond this the last tile carries a "+N" overlay
// for the rest instead of growing the grid further. Mirrors the webapp rule
// (NoteImageGallery.tsx) so the two clients agree on how a note's images fold.
const GRID_VISIBLE_TILES = 4;
const GRID_CLEAR_TILES = GRID_VISIBLE_TILES - 1;
const BANNER_MAX_HEIGHT = 240;

// Gallery of a note's images: a full-width banner for a single image, or a
// responsive 2-column grid for 2+ (laid out from width/height so the reserved
// space roughly matches the image before it loads). Tapping a persisted tile
// opens the full-screen swipeable lightbox at that image's index. In editable
// mode, persisted tiles get a remove button and `uploads` render as
// queued/uploading/error placeholders (the add/remove UI lives in
// NoteEditorScreen).
export default function NoteImageGallery({ images, editable = false, uploads = [], onRemove, onRetryUpload, onDismissUpload }: NoteImageGalleryProps) {
  const { t } = useTranslation();
  const baseUrl = useActiveServerBaseUrl();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Measured width of the single-image banner container, used to size the
  // banner by an explicit height rather than the `aspectRatio` style prop —
  // Yoga resolves a conflict between a percentage width and an aspectRatio
  // capped by maxHeight by shrinking width instead of cropping height, which
  // left portrait images rendered narrower than full width.
  const [bannerWidth, setBannerWidth] = useState(0);

  // Uploads sort before persisted images (not after) so a newly-added upload
  // never falls past the visible window and loses its progress/error/retry
  // feedback once a note already has GRID_VISIBLE_TILES images. Overflow from
  // that folds the oldest persisted images into the "+N" tile first, never an
  // in-flight upload.
  let tiles: Tile[] = [
    ...uploads.map((upload): Tile => ({ key: upload.id, kind: 'upload', upload })),
    ...images.map((image): Tile => ({ key: image.id, kind: 'image', image })),
  ];

  if (tiles.length === 0) return null;

  const visibleCount = Math.min(tiles.length, GRID_VISIBLE_TILES);
  const overlayCount = tiles.length > GRID_VISIBLE_TILES ? tiles.length - GRID_CLEAR_TILES : 0;

  // The overlay slot (last visible tile when overflowing) loses its own
  // controls — it just represents "N more." An upload stuck there has no way
  // to retry or dismiss it at all, which is worse than an image losing its
  // remove button there, so when an image exists, swap it into that slot
  // instead (only reachable when uploads alone already fill every visible
  // slot, i.e. 4+ concurrent uploads).
  if (overlayCount > 0 && tiles[visibleCount - 1].kind === 'upload') {
    const imageIndex = tiles.findIndex((tile) => tile.kind === 'image');
    if (imageIndex >= visibleCount) {
      const swapped = [...tiles];
      [swapped[visibleCount - 1], swapped[imageIndex]] = [swapped[imageIndex], swapped[visibleCount - 1]];
      tiles = swapped;
    }
  }

  const visibleTiles = tiles.slice(0, visibleCount);
  const isGrid = tiles.length > 1;
  // An odd tile count of 3 spans the final tile across both columns so it
  // doesn't leave a dangling empty cell.
  const spanLastTile = isGrid && visibleCount === 3;

  const renderTile = (tile: Tile, index: number) => {
    const isOverlayTile = overlayCount > 0 && index === visibleCount - 1;
    const aspectRatio = tile.kind === 'image' && tile.image.width && tile.image.height
      ? tile.image.width / tile.image.height
      : 4 / 3;
    const tileStyle = isGrid
      ? [styles.gridTile, spanLastTile && index === 2 ? styles.spanTwoColumns : null]
      : [
          styles.bannerTile,
          bannerWidth > 0 ? { height: Math.min(bannerWidth / aspectRatio, BANNER_MAX_HEIGHT) } : { aspectRatio },
        ];

    if (tile.kind === 'image') {
      // Uploads sort before images in `tiles`, so a tile's position there no
      // longer matches its position in `images` — look up the real index for
      // the lightbox rather than reusing `index`.
      const imageIndex = images.findIndex((img) => img.id === tile.image.id);
      const label = isOverlayTile
        ? t('images.moreImages', { count: overlayCount })
        : t('images.openLightbox', { filename: tile.image.filename });
      return (
        <View key={tile.key} style={tileStyle}>
          <TouchableOpacity
            style={styles.fill}
            onPress={() => setLightboxIndex(imageIndex)}
            accessibilityLabel={label}
            accessibilityRole="button"
            testID={isGrid ? `note-image-grid-tile-${tile.image.id}` : `note-image-banner-${tile.image.id}`}
          >
            <CachedNoteImage
              imageId={tile.image.id}
              variant="thumbnail"
              networkUrl={noteImageThumbnailUrl(baseUrl, tile.image.id)}
              style={styles.tileImage}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
            {isOverlayTile && (
              <View style={styles.overlay} testID={`note-image-overlay-${tile.image.id}`}>
                <Text style={styles.overlayText}>+{overlayCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          {editable && onRemove && !isOverlayTile && (
            <TouchableOpacity
              style={styles.removeButton}
              onPress={() => onRemove(tile.image)}
              accessibilityLabel={t('images.removeImage', { filename: tile.image.filename })}
              accessibilityRole="button"
              testID={`remove-image-${tile.image.id}`}
            >
              <Ionicons name="trash" size={16} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      );
    }

    const { upload } = tile;
    return (
      <View key={tile.key} style={tileStyle} testID={`image-upload-tile-${upload.id}`}>
        <Image source={{ uri: upload.previewUri }} style={[styles.tileImage, styles.uploadPreviewDim]} resizeMode="cover" />
        {!isOverlayTile && (
          <View style={styles.uploadStatus} testID={`image-upload-status-${upload.id}`}>
            {upload.status === 'uploading' ? (
              <>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.uploadStatusText}>{t('images.uploading', { percent: upload.progress })}</Text>
              </>
            ) : upload.status === 'queued' ? (
              <>
                <Ionicons name="cloud-offline-outline" size={20} color="#fff" />
                <Text style={styles.uploadStatusText}>{t('images.queuedOffline')}</Text>
                {onDismissUpload && (
                  <TouchableOpacity
                    style={styles.uploadActionButton}
                    onPress={() => onDismissUpload(upload.id)}
                    accessibilityLabel={t('images.dismissUpload', { filename: upload.filename })}
                    accessibilityRole="button"
                    testID={`dismiss-upload-${upload.id}`}
                  >
                    <Ionicons name="close" size={16} color="#fff" />
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <>
                <Text style={styles.uploadStatusText}>{upload.errorMessage ?? t('images.uploadFailed')}</Text>
                <View style={styles.uploadActionsRow}>
                  {onRetryUpload && (
                    <TouchableOpacity
                      style={styles.uploadActionButton}
                      onPress={() => onRetryUpload(upload.id)}
                      accessibilityLabel={t('images.retryUpload', { filename: upload.filename })}
                      accessibilityRole="button"
                      testID={`retry-upload-${upload.id}`}
                    >
                      <Ionicons name="refresh" size={16} color="#fff" />
                    </TouchableOpacity>
                  )}
                  {onDismissUpload && (
                    <TouchableOpacity
                      style={styles.uploadActionButton}
                      onPress={() => onDismissUpload(upload.id)}
                      accessibilityLabel={t('images.dismissUpload', { filename: upload.filename })}
                      accessibilityRole="button"
                      testID={`dismiss-upload-${upload.id}`}
                    >
                      <Ionicons name="close" size={16} color="#fff" />
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}
          </View>
        )}
        {isOverlayTile && (
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>+{overlayCount}</Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <>
      {isGrid ? (
        <View style={styles.grid} testID="note-image-grid">
          {visibleTiles.map((tile, i) => renderTile(tile, i))}
        </View>
      ) : (
        <View
          testID="note-image-banner-container"
          onLayout={(e) => setBannerWidth(e.nativeEvent.layout.width)}
        >
          {renderTile(visibleTiles[0], 0)}
        </View>
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
  fill: {
    width: '100%',
    height: '100%',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  uploadPreviewDim: {
    opacity: 0.5,
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
  removeButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    padding: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  uploadStatus: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    padding: 8,
  },
  uploadStatusText: {
    color: '#fff',
    fontSize: 12,
    textAlign: 'center',
  },
  uploadActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  uploadActionButton: {
    padding: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
});
