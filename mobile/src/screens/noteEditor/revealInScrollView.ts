/**
 * Keeping a focused input visible inside the editor's scroll view.
 *
 * React Native's `scrollResponderScrollNativeHandleToKeyboard` assumes the
 * scroll view runs from the top of the screen down to the keyboard. The editor
 * breaks both assumptions — the header and banners sit above it, and the
 * formatting and action bars sit between it and the keyboard — so it scrolled a
 * focused row too far back up, leaving it hidden under those bars. Measuring the
 * scroll view and the input in the same (window) coordinates instead needs no
 * knowledge of what surrounds the scroll view or where the keyboard is: once the
 * keyboard and bars are laid out, the scroll view's own frame is the visible
 * area.
 */

import type { ScrollView, TextInput } from 'react-native';

interface Measurable {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}

interface ScrollableMeasurable extends Measurable {
  scrollTo: (options: { y: number; animated?: boolean }) => void;
}

export interface RevealGeometry {
  /** The scroll view's current content offset. */
  scrollOffset: number;
  /** The scroll view's top edge, in window coordinates. */
  viewportTop: number;
  viewportHeight: number;
  /** The target's top edge, in window coordinates. */
  targetTop: number;
  targetHeight: number;
  /** Breathing room kept between the target and the viewport's edges. */
  margin: number;
  /**
   * Leave a target that does not overlap the viewport where it is. For
   * re-reveals nobody asked for (the content or the viewport changed size): a
   * row the user scrolled away from must not pull them back to it. `true`
   * checks the viewport as it is now; a number checks only its first that many
   * points — its height before a resize, so a row the shrink just covered still
   * counts as shown.
   */
  onlyIfShown?: boolean | number;
}

/**
 * The content offset that brings the target fully into view with the least
 * movement, or null when it is already visible (or nothing was measured).
 */
export function scrollOffsetToReveal({
  scrollOffset,
  viewportTop,
  viewportHeight,
  targetTop,
  targetHeight,
  margin,
  onlyIfShown = false,
}: RevealGeometry): number | null {
  // A view that has not been laid out yet measures as zero; scrolling on that
  // would only jump the list.
  if (viewportHeight <= 0 || targetHeight <= 0) return null;

  const targetBottom = targetTop + targetHeight;
  if (onlyIfShown !== false) {
    const shownHeight = onlyIfShown === true ? viewportHeight : onlyIfShown;
    if (targetBottom <= viewportTop || targetTop >= viewportTop + shownHeight) return null;
  }

  // Shrink the margin when the viewport is too short to fit it on both sides.
  const inset = Math.min(margin, Math.max(0, (viewportHeight - targetHeight) / 2));
  const visibleTop = viewportTop + inset;
  const visibleBottom = viewportTop + viewportHeight - inset;

  let delta = 0;
  if (targetHeight > visibleBottom - visibleTop) {
    // Taller than the viewport: fill it with the least movement, and leave it
    // be once it does. The caret can be anywhere in it — realigning its top on
    // every wrap would scroll away the line being typed at its end.
    if (targetTop > visibleTop) delta = targetTop - visibleTop;
    else if (targetBottom < visibleBottom) delta = targetBottom - visibleBottom;
  } else if (targetTop < visibleTop) {
    delta = targetTop - visibleTop;
  } else if (targetBottom > visibleBottom) {
    delta = targetBottom - visibleBottom;
  }
  if (Math.abs(delta) < 1) return null;
  return Math.max(0, scrollOffset + delta);
}

function isMeasurable(value: unknown): value is Measurable {
  return typeof (value as Partial<Measurable> | null)?.measureInWindow === 'function';
}

export type RevealOptions = Pick<RevealGeometry, 'margin' | 'onlyIfShown'> & {
  /** Reads the scroll view's current content offset. */
  scrollOffset: () => number;
};

/**
 * Scrolls `scrollView` just far enough to show `target`. Silently does nothing
 * when either side cannot be measured (unmounted, or a test renderer).
 */
export function revealInScrollView(
  scrollView: ScrollView | null,
  target: TextInput | null,
  { scrollOffset, margin, onlyIfShown = false }: RevealOptions,
): void {
  // ScrollView's type omits the host methods its instance carries at runtime,
  // so check for them rather than trusting the declared type.
  if (!scrollView || !target || !isMeasurable(scrollView) || !isMeasurable(target)) return;
  const scrollable = scrollView as unknown as ScrollableMeasurable;
  if (typeof scrollable.scrollTo !== 'function') return;
  scrollable.measureInWindow((_vx, viewportTop, _vw, viewportHeight) => {
    target.measureInWindow((_tx, targetTop, _tw, targetHeight) => {
      const y = scrollOffsetToReveal({
        scrollOffset: scrollOffset(),
        viewportTop,
        viewportHeight,
        targetTop,
        targetHeight,
        margin,
        onlyIfShown,
      });
      if (y !== null) scrollable.scrollTo({ y, animated: true });
    });
  });
}
