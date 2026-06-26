import React, { useEffect, useRef } from 'react';
import { Animated, type ViewProps } from 'react-native';
import { isReduceMotionEnabledSync } from '../utils/layoutAnimation';

interface FadeInViewProps extends ViewProps {
  /** Fade duration in ms. Kept subtle to match the webapp's entrance animations. */
  duration?: number;
  /**
   * When set, the view also scales from this value up to 1 alongside the fade
   * (e.g. 0.97 for a gentle "pop-in"). Omit for a pure fade.
   */
  scaleFrom?: number;
}

/**
 * Fades (and optionally scales) its children in once, on mount. Mirrors the
 * webapp's entrance animations and the Animated.timing approach already used by
 * Banner. No-ops when the OS "Reduce Motion" setting is on, rendering at the
 * final opacity/scale immediately.
 *
 * The animation runs on mount only, so callers get the absent→present fade by
 * conditionally mounting this component (e.g. `error ? <FadeInView>…` ); it does
 * not re-trigger on unrelated parent re-renders.
 */
export default function FadeInView({
  duration = 200,
  scaleFrom,
  style,
  children,
  ...rest
}: FadeInViewProps) {
  // Decide once at mount so a mid-animation Reduce Motion toggle can't strand the
  // view at a partial opacity.
  const reduceMotion = useRef(isReduceMotionEnabledSync()).current;
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const scale = useRef(
    new Animated.Value(reduceMotion || scaleFrom === undefined ? 1 : scaleFrom),
  ).current;

  useEffect(() => {
    if (reduceMotion) return;
    const timings = [
      Animated.timing(opacity, { toValue: 1, duration, useNativeDriver: true }),
    ];
    if (scaleFrom !== undefined) {
      timings.push(Animated.timing(scale, { toValue: 1, duration, useNativeDriver: true }));
    }
    const animation = Animated.parallel(timings);
    animation.start();
    return () => animation.stop();
  }, [duration, opacity, reduceMotion, scale, scaleFrom]);

  return (
    <Animated.View
      style={[
        style,
        { opacity, ...(scaleFrom !== undefined ? { transform: [{ scale }] } : null) },
      ]}
      {...rest}
    >
      {children}
    </Animated.View>
  );
}
