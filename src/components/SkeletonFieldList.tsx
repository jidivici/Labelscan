/**
 * Skeleton placeholders for the Review field list while the server extraction (OCR + LLM)
 * is still running, after the GS1 fields have already been shown at T+0.
 *
 * `SkeletonValue` is one pulsing value block whose geometry matches EditableFieldRow's
 * input, so a per-field cascade (ReviewScreen) can render a STABLE 16-row list from T+0 —
 * GS1 rows filled, the rest skeletoned IN PLACE — and swap each skeleton for the real
 * field with zero layout shift.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { colors, radius } from '../theme';

/** One pulsing value block (same height as the bordered TextInput, so nothing shifts). */
export function SkeletonValue() {
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[styles.valueBlock, { opacity: pulse }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Champ en cours d’analyse"
    />
  );
}

const styles = StyleSheet.create({
  // Stands in for the input (same height as the bordered TextInput so nothing shifts).
  valueBlock: {
    height: 40,
    width: '100%',
    borderRadius: radius.md,
    backgroundColor: colors.surfaceContainer,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
});
