import { useCallback, useEffect } from 'react';
import { Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react';
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import type { NoteImage } from '@jot/shared';
import { images as imagesApi } from '@/utils/api';

interface ImageLightboxProps {
  images: NoteImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

// Full-screen viewer for a note's images. Always serves the original (never
// a thumbnail) since this is where a user inspects the image closely.
export default function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const { t } = useTranslation();
  const image = images[index];
  const hasMultiple = images.length > 1;

  const goToPrevious = useCallback(() => {
    onIndexChange((index - 1 + images.length) % images.length);
  }, [index, images.length, onIndexChange]);

  const goToNext = useCallback(() => {
    onIndexChange((index + 1) % images.length);
  }, [index, images.length, onIndexChange]);

  useEffect(() => {
    if (!hasMultiple) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrevious();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasMultiple, goToPrevious, goToNext]);

  if (!image) return null;

  return (
    <Dialog open={true} onClose={onClose} className="relative z-[70]">
      <DialogBackdrop transition aria-hidden="true" className="fixed inset-0 bg-black/80 transition duration-200 ease-out data-[closed]:opacity-0 motion-reduce:transition-none" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="relative flex items-center justify-center max-w-[95vw] max-h-[95vh] transition duration-200 ease-out data-[closed]:scale-95 data-[closed]:opacity-0 motion-reduce:transition-none"
        >
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="absolute -top-10 right-0 p-1 text-white hover:text-gray-300"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
          {hasMultiple && (
            <>
              <button
                type="button"
                aria-label={t('images.lightboxPrevious')}
                onClick={goToPrevious}
                className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white hover:bg-black/60"
              >
                <ChevronLeftIcon className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label={t('images.lightboxNext')}
                onClick={goToNext}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white hover:bg-black/60"
              >
                <ChevronRightIcon className="h-6 w-6" />
              </button>
            </>
          )}
          <img
            src={imagesApi.url(image.id)}
            alt={image.filename}
            className="max-w-[95vw] max-h-[95vh] object-contain"
          />
          {hasMultiple && (
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-sm text-white">
              {t('images.lightboxCounter', { current: index + 1, total: images.length })}
            </div>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
