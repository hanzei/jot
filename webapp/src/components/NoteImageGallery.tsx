import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowPathIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { NoteImage } from '@jot/shared';
import { images as imagesApi } from '@/utils/api';
import ImageLightbox from '@/components/ImageLightbox';

// A locally-tracked upload in flight (or failed) for a note, rendered as a
// gallery tile alongside the note's persisted images. Never sent to the
// server as-is — id is a client-generated key, not a NoteImage id.
export interface PendingImageUpload {
  id: string;
  filename: string;
  previewUrl: string;
  progress: number;
  status: 'uploading' | 'error';
  errorMessage?: string;
}

interface NoteImageGalleryProps {
  images: NoteImage[];
  // Adding editable=true turns on hover remove buttons for persisted images
  // and renders `uploads` as in-progress/error tiles. Read-only callers (none
  // currently) can omit it and get the original display-only gallery.
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
// for the rest instead of growing the grid further.
const GRID_VISIBLE_TILES = 4;
// When overflowing, only this many tiles render their image clearly — the
// final visible tile becomes the "+N" overlay tile.
const GRID_CLEAR_TILES = GRID_VISIBLE_TILES - 1;

const TILE_FRAME_CLASSNAME = 'group relative overflow-hidden rounded-md bg-gray-100 dark:bg-slate-700';

// Display of a note's images: a full-width banner for a single tile, or a
// responsive grid for 2+ (laid out from width/height so the reserved space
// matches the image before it loads, avoiding reflow). Tapping a persisted
// image tile opens the full-screen lightbox. In editable mode, persisted
// tiles get a hover remove button and `uploads` render as
// queued/uploading/error placeholders (add/remove UI lives in NoteModal).
export default function NoteImageGallery({ images, editable = false, uploads = [], onRemove, onRetryUpload, onDismissUpload }: NoteImageGalleryProps) {
  const { t } = useTranslation();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Uploads sort before persisted images (not after) so that once a note
  // already has GRID_VISIBLE_TILES images, a newly-added upload doesn't fall
  // past the visible window and get silently dropped — with no progress or
  // error/retry feedback at all — in favor of an image the user isn't
  // actively acting on right now. Overflow from that then folds the oldest
  // persisted images into the "+N" tile first, never an in-flight upload.
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
  // instead of leaving an upload there (only reachable when uploads.length
  // alone already fills every visible slot, i.e. 4+ concurrent uploads).
  if (overlayCount > 0 && tiles[visibleCount - 1].kind === 'upload') {
    const imageIndex = tiles.findIndex(tile => tile.kind === 'image');
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

  // Renders a single tile. The remove/retry/dismiss controls are always
  // siblings of the (optional) clickable image button, never nested inside
  // it — a <button> inside another <button> is invalid HTML and would break
  // click and keyboard handling.
  const renderTile = (tile: Tile, index: number) => {
    const isOverlayTile = overlayCount > 0 && index === visibleCount - 1;
    const frameStyle = isGrid ? undefined : { aspectRatio: tile.kind === 'image' ? `${tile.image.width} / ${tile.image.height}` : '4 / 3' };
    const frameClassName = `${TILE_FRAME_CLASSNAME} ${isGrid ? 'aspect-square' : 'block w-full max-h-80'} ${
      spanLastTile && index === 2 ? 'col-span-2' : ''
    }`;

    if (tile.kind === 'image') {
      // Uploads sort before images in `tiles` (see above), so a tile's
      // position there no longer matches its position in `images` — look up
      // the real index for the lightbox rather than reusing `index`.
      const imageIndex = images.findIndex(img => img.id === tile.image.id);
      const label = isOverlayTile
        ? t('images.moreImages', { count: overlayCount })
        : t('images.openLightbox', { filename: tile.image.filename });
      return (
        <div key={tile.key} className={frameClassName} style={frameStyle}>
          <button
            type="button"
            aria-label={label}
            className="absolute inset-0 w-full h-full"
            onClick={() => setLightboxIndex(imageIndex)}
          >
            <img src={imagesApi.thumbnailUrl(tile.image.id)} alt={tile.image.filename} className="w-full h-full object-cover" />
            {isOverlayTile && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-lg font-medium">
                +{overlayCount}
              </span>
            )}
          </button>
          {editable && onRemove && !isOverlayTile && (
            <button
              type="button"
              aria-label={t('images.removeImage', { filename: tile.image.filename })}
              onClick={() => onRemove(tile.image)}
              className="absolute top-1 right-1 z-10 p-1 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-black/70 transition-opacity"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      );
    }

    const { upload } = tile;
    return (
      <div key={tile.key} className={frameClassName} style={frameStyle}>
        <img src={upload.previewUrl} alt={upload.filename} className="w-full h-full object-cover opacity-50" />
        {!isOverlayTile && (
          <div
            role="status"
            data-testid="image-upload-tile"
            data-status={upload.status}
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 text-white text-xs p-2 text-center"
          >
            {upload.status === 'uploading' ? (
              <span>{t('images.uploading', { percent: upload.progress })}</span>
            ) : (
              <>
                <span>{upload.errorMessage ?? t('images.uploadFailed')}</span>
                <div className="flex items-center gap-2">
                  {onRetryUpload && (
                    <button
                      type="button"
                      aria-label={t('images.retryUpload', { filename: upload.filename })}
                      onClick={() => onRetryUpload(upload.id)}
                      className="p-1 rounded-full bg-white/20 hover:bg-white/30"
                    >
                      <ArrowPathIcon className="h-4 w-4" />
                    </button>
                  )}
                  {onDismissUpload && (
                    <button
                      type="button"
                      aria-label={t('images.dismissUpload', { filename: upload.filename })}
                      onClick={() => onDismissUpload(upload.id)}
                      className="p-1 rounded-full bg-white/20 hover:bg-white/30"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {isOverlayTile && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-lg font-medium">
            +{overlayCount}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      {isGrid ? (
        <div className="grid grid-cols-2 gap-1" data-testid="note-image-grid">
          {visibleTiles.map((tile, i) => renderTile(tile, i))}
        </div>
      ) : (
        renderTile(visibleTiles[0], 0)
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
