import { useLayoutEffect, useRef } from 'react';

const DEFAULT_DURATION = 200;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface SizeTransitionOptions {
  /** Animation duration in milliseconds. */
  duration?: number;
}

/**
 * Smoothly animates an element's height whenever it changes between renders.
 * Attach the returned ref to the element, and pass a `trigger` value that
 * changes only on the structural updates that should animate (e.g. an item
 * being checked off), so routine re-renders like typing don't animate.
 *
 * The height is animated with the Web Animations API using explicit pixel
 * keyframes, so the element keeps its natural `height: auto` sizing and no
 * inline styles are left behind once the animation finishes.
 */
export function useSizeTransition<T extends HTMLElement>(
  trigger: unknown,
  { duration = DEFAULT_DURATION }: SizeTransitionOptions = {},
) {
  const ref = useRef<T | null>(null);
  const previousHeight = useRef<number | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const nextHeight = element.getBoundingClientRect().height;
    const prevHeight = previousHeight.current;
    previousHeight.current = nextHeight;

    if (
      prevHeight === null ||
      prefersReducedMotion() ||
      typeof element.animate !== 'function' ||
      Math.abs(prevHeight - nextHeight) <= 1
    ) {
      return;
    }

    // Cancel any in-flight height animation so rapid trigger changes don't
    // stack overlapping animations (which causes jitter).
    animationRef.current?.cancel();
    animationRef.current = element.animate(
      [{ height: `${prevHeight}px` }, { height: `${nextHeight}px` }],
      { duration, easing: 'ease-out' },
    );

    return () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    };
  }, [trigger, duration]);

  return ref;
}
