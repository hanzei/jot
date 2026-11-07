import { useCallback, useMemo, useRef } from 'react';
import type { LayoutChangeEvent, ScrollView, TextInput } from 'react-native';
import { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { revealInScrollView } from './revealInScrollView';

// Room kept between a revealed input and the edges of the visible area, so it
// is not flush against the formatting bar.
const REVEAL_MARGIN = 24;

/**
 * Keeps the focused input of a scroll view in view. `reveal` is for the focus
 * itself; spread `scrollViewProps` onto the scroll view for what happens after
 * it:
 *
 * - `onLayout`: the keyboard and formatting bar arrive after the focus and
 *   shrink the view. Following Android's own rule for a shrinking ScrollView,
 *   the input is brought back only if it was on screen at the previous height,
 *   so a banner or toast does not pull back a user who scrolled away from it.
 * - `onContentSizeChange`: an input that grows as its text wraps can run under
 *   the bar; it is followed only while it is on screen.
 */
export function useRevealFocusedInput(
  scrollViewRef: React.RefObject<ScrollView | null>,
  getFocusedInput: () => TextInput | null,
) {
  const scrollOffset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollOffset.set(event.contentOffset.y);
  });

  const reveal = useCallback((input: TextInput | null, shownHeight: number | null = null) => {
    revealInScrollView(scrollViewRef.current, input, {
      scrollOffset: () => scrollOffset.get(),
      margin: REVEAL_MARGIN,
      shownHeight,
    });
  }, [scrollViewRef, scrollOffset]);

  // The view's height as of its last layout; null until the first one, which
  // is not a resize.
  const viewportHeightRef = useRef<number | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const previousHeight = viewportHeightRef.current;
    viewportHeightRef.current = event.nativeEvent.layout.height;
    if (previousHeight !== null) reveal(getFocusedInput(), previousHeight);
  }, [reveal, getFocusedInput]);

  const onContentSizeChange = useCallback(() => {
    const height = viewportHeightRef.current;
    if (height !== null) reveal(getFocusedInput(), height);
  }, [reveal, getFocusedInput]);

  const scrollViewProps = useMemo(
    () => ({ onScroll, onLayout, onContentSizeChange }),
    [onScroll, onLayout, onContentSizeChange],
  );
  return { reveal, scrollViewProps };
}
