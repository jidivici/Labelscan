/**
 * A softly pulsing filled dot — the sober "live / working" cue used across loading states
 * INSTEAD of a spinning wheel (docs/LATENCY-REVIEW.md §5). Shared by the extraction cascade
 * (ExtractionProgress) and the upload overlay (ProcessingOverlay) so the whole capture→review
 * flow speaks one visual language: no `ActivityIndicator` anywhere on the hot path.
 */

import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

import { colors } from '../theme';

export function PulseDot({ size = 13, color = colors.primary }: { size?: number; color?: string }) {
  const opacity = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity }}
    />
  );
}
