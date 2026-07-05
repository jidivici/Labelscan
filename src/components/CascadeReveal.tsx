/**
 * CascadeReveal — the reveal animation of the loading cascade (Tier 3 visuals).
 *
 * Each value that arrives on the Review list (GS1 at T+0, deterministic wave-2
 * previews at ocr_done, LLM fields at ready) fades in and settles upward over
 * ~240 ms, staggered top-to-bottom by the caller (`delay`) — the screen visibly
 * FILLS ITSELF as the extraction progresses, instead of values popping in.
 *
 * Deliberately subtle (Clean UI): opacity + 6 px translate only — geometry is
 * untouched, so the zero-layout-shift guarantee of the stable field list holds.
 * Uses the core RN Animated API with the native driver (no reanimated worklet —
 * this must stay renderable in any context, including tests).
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

export function CascadeReveal({
  delay = 0,
  children,
}: {
  /** Stagger offset in ms — the caller derives it from the row position. */
  delay?: number;
  children: React.ReactNode;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 240,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, delay]);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [6, 0],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** Per-row stagger: top-to-bottom sweep, capped so long lists never feel slow. */
export function cascadeDelay(rowIndex: number): number {
  return Math.min(rowIndex * 45, 450);
}
