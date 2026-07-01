import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NoteImage } from '@jot/shared';
import { images as imagesApi } from '@/utils/api';
import ImageLightbox from '@/components/ImageLightbox';

interface NoteImageGalleryProps {
  images: NoteImage[];
}

// Grid tiles shown at once; beyond this the last tile carries a "+N" overlay
// for the rest instead of growing the grid further.
const GRID_VISIBLE_TILES = 4;
// When overflowing, only this many tiles render their image clearly — the
// final visible tile becomes the "+N" overlay tile.
const GRID_CLEAR_TILES = GRID_VISIBLE_TILES - 1;

// Read-only display of a note's images: a full-width banner for a single
// image, or a responsive grid for 2+ (laid out from width/height so the
// reserved space matches the image before it loads, avoiding reflow). Tapping
// any tile opens the full-screen lightbox. Upload/remove is out of scope here.
export default function NoteImageGallery({ images }: NoteImageGalleryProps) {
  const { t } = useTranslation();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (images.length === 0) return null;

  if (images.length === 1) {
    const image = images[0];
    return (
      <>
        <button
          type="button"
          aria-label={t('images.openLightbox', { filename: image.filename })}
          className="block w-full max-h-80 overflow-hidden rounded-md bg-gray-100 dark:bg-slate-700"
          style={{ aspectRatio: `${image.width} / ${image.height}` }}
          onClick={() => setLightboxIndex(0)}
        >
          <img src={imagesApi.url(image.id)} alt={image.filename} className="w-full h-full object-cover" />
        </button>
        {lightboxIndex !== null && (
          <ImageLightbox
            images={images}
            index={lightboxIndex}
            onIndexChange={setLightboxIndex}
            onClose={() => setLightboxIndex(null)}
          />
        )}
      </>
    );
  }

  const visibleCount = Math.min(images.length, GRID_VISIBLE_TILES);
  const overlayCount = images.length > GRID_VISIBLE_TILES ? images.length - GRID_CLEAR_TILES : 0;
  const visibleImages = images.slice(0, visibleCount);
  // An odd tile count of 3 spans the final tile across both columns so it
  // doesn't leave a dangling empty cell.
  const spanLastTile = visibleCount === 3;

  return (
    <>
      <div className="grid grid-cols-2 gap-1" data-testid="note-image-grid">
        {visibleImages.map((image, i) => {
          const isOverlayTile = overlayCount > 0 && i === visibleCount - 1;
          return (
            <button
              key={image.id}
              type="button"
              aria-label={
                isOverlayTile
                  ? t('images.moreImages', { count: overlayCount })
                  : t('images.openLightbox', { filename: image.filename })
              }
              className={`relative aspect-square overflow-hidden rounded-md bg-gray-100 dark:bg-slate-700 ${
                spanLastTile && i === 2 ? 'col-span-2' : ''
              }`}
              onClick={() => setLightboxIndex(i)}
            >
              <img src={imagesApi.url(image.id)} alt={image.filename} className="w-full h-full object-cover" />
              {isOverlayTile && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-lg font-medium">
                  +{overlayCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
