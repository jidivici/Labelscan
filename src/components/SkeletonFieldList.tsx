/**
 * Skeleton placeholders for the Review field list while the server extraction (OCR + LLM)
 * is still running, after the GS1 fields have already been shown at T+0.
 *
 * `SkeletonValue` is one pulsing value block whose geometry matches EditableFieldRow's
 * input, so a per-field cascade (ReviewScreen) can render a STABLE 16-row list from T+0 —
 * GS1 rows filled, the rest skeletoned IN PLACE — and swap each skeleton for the real
 * field with zero layout shift. `SkeletonFieldList` is the legacy whole-block variant.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors, spacing, radius } from '../theme';

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

interface SkeletonFieldListProps {
  /** How many placeholder rows to render (≈ the typical free-text field count). */
  count?: number;
}

export function SkeletonFieldList({ count = 6 }: SkeletonFieldListProps) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Analyse de l’étiquette en cours">
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={styles.row}>
          <View style={styles.labelBar} />
          <SkeletonValue />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matches EditableFieldRow: paddingVertical spacing.sm + a bottom divider.
  row: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  // Stands in for the uppercase field label (labelSmall + its marginBottom).
  labelBar: {
    height: 10,
    width: '34%',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceContainerHigh,
    marginBottom: spacing.xs + 4,
  },
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
