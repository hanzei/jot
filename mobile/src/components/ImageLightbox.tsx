import { useCallback, useEffect, useRef } from 'react';
import { Modal, View, Text, TouchableOpacity, FlatList, useWindowDimensions, StyleSheet, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { NoteImage } from '@jot/shared';
import { useActiveServerBaseUrl } from '../hooks/useActiveServerBaseUrl';
import { noteImageUrl } from '../api/images';
import CachedNoteImage from './CachedNoteImage';
import { useDeviceSafeAreaInsets } from './ContentSafeArea';

interface ImageLightboxProps {
  images: NoteImage[];
  /** null means closed; the component renders nothing in that case. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

// Base offsets for controls that sit against a screen edge; the safe-area
// inset for that edge is added on top so they clear notches/gesture bars.
const CLOSE_BUTTON_TOP = 16;
const CLOSE_BUTTON_RIGHT = 16;
const COUNTER_BOTTOM = 16;

// Full-screen swipeable viewer for a note's images, opened by tapping a
// gallery tile. Always serves the original (never a thumbnail) since this is
// where a user inspects the image closely. Chevron buttons are offered
// alongside the swipe gesture for reachability/testability.
export default function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const { t } = useTranslation();
  const baseUrl = useActiveServerBaseUrl();
  const listRef = useRef<FlatList<NoteImage>>(null);
  const { width: screenWidth } = useWindowDimensions();
  // A Modal renders above the top banner stack in its own native window, so
  // the status bar is uncovered here and the device's real insets apply.
  const insets = useDeviceSafeAreaInsets();

  const isOpen = index !== null;
  // Clamp against a live SSE removal shrinking `images` while open, rather
  // than index a stale out-of-range position.
  const safeIndex = index === null ? null : Math.min(index, images.length - 1);
  const hasMultiple = images.length > 1;

  useEffect(() => {
    if (!isOpen || safeIndex === null) return;
    // Jump to the target page without animation whenever the lightbox opens
    // or the index is changed externally (e.g. a chevron press).
    listRef.current?.scrollToOffset({ offset: safeIndex * screenWidth, animated: false });
  }, [isOpen, safeIndex, screenWidth]);

  const goToPrevious = useCallback(() => {
    if (safeIndex === null) return;
    onIndexChange((safeIndex - 1 + images.length) % images.length);
  }, [safeIndex, images.length, onIndexChange]);

  const goToNext = useCallback(() => {
    if (safeIndex === null) return;
    onIndexChange((safeIndex + 1) % images.length);
  }, [safeIndex, images.length, onIndexChange]);

  const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const newIndex = Math.round(event.nativeEvent.contentOffset.x / screenWidth);
    if (newIndex !== safeIndex && newIndex >= 0 && newIndex < images.length) {
      onIndexChange(newIndex);
    }
  }, [safeIndex, images.length, onIndexChange, screenWidth]);

  if (!isOpen || safeIndex === null) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} testID="image-lightbox">
      <View style={styles.backdrop}>
        <TouchableOpacity
          style={[styles.closeButton, { top: CLOSE_BUTTON_TOP + insets.top, right: CLOSE_BUTTON_RIGHT + insets.right }]}
          onPress={onClose}
          accessibilityLabel={t('common.close')}
          accessibilityRole="button"
          testID="lightbox-close"
        >
          <X size={28} color="#fff" />
        </TouchableOpacity>

        {hasMultiple && (
          <>
            <TouchableOpacity
              style={[styles.navButton, styles.navButtonLeft]}
              onPress={goToPrevious}
              accessibilityLabel={t('images.lightboxPrevious')}
              accessibilityRole="button"
              testID="lightbox-previous"
            >
              <ChevronLeft size={28} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.navButton, styles.navButtonRight]}
              onPress={goToNext}
              accessibilityLabel={t('images.lightboxNext')}
              accessibilityRole="button"
              testID="lightbox-next"
            >
              <ChevronRight size={28} color="#fff" />
            </TouchableOpacity>
          </>
        )}

        <FlatList
          ref={listRef}
          data={images}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={safeIndex}
          getItemLayout={(_, i) => ({ length: screenWidth, offset: screenWidth * i, index: i })}
          keyExtractor={(img) => img.id}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          // Cap windowing so opening the lightbox on a note with many images
          // doesn't kick off a full-resolution CachedNoteImage download (issue
          // #618) for every image at once — only the current page and its
          // immediate neighbors render ahead of a swipe.
          initialNumToRender={1}
          windowSize={3}
          testID="lightbox-pager"
          renderItem={({ item }) => (
            <View style={[styles.page, { width: screenWidth }]} testID={`lightbox-page-${item.id}`}>
              <CachedNoteImage
                imageId={item.id}
                variant="original"
                networkUrl={noteImageUrl(baseUrl, item.id)}
                style={styles.image}
                resizeMode="contain"
                accessibilityLabel={item.filename}
              />
            </View>
          )}
        />

        {hasMultiple && (
          <Text style={[styles.counter, { bottom: COUNTER_BOTTOM + insets.bottom }]} testID="lightbox-counter">
            {t('images.lightboxCounter', { current: safeIndex + 1, total: images.length })}
          </Text>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    zIndex: 10,
    padding: 8,
  },
  navButton: {
    position: 'absolute',
    top: '50%',
    marginTop: -20,
    zIndex: 10,
    padding: 8,
  },
  navButtonLeft: {
    left: 8,
  },
  navButtonRight: {
    right: 8,
  },
  page: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#fff',
    fontSize: 13,
  },
});
