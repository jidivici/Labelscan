/**
 * SkeletonFieldList — placeholder rows shown while the server extraction (OCR + LLM)
 * is still running, after the GS1 fields have already been shown at T+0.
 *
 * Each row mirrors the geometry of ReviewScreen's EditableFieldRow (an uppercase
 * label line above a full-width input block) so that when the real fields arrive the
 * already-visible header/meta does not jump — only these placeholders are replaced.
 * A single shared opacity pulse (native-driven) reads as "loading" without motion noise.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors, spacing, radius } from '../theme';

interface SkeletonFieldListProps {
  /** How many placeholder rows to render (≈ the typical free-text field count). */
  count?: number;
}

export function SkeletonFieldList({ count = 6 }: SkeletonFieldListProps) {
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
    <View accessibilityRole="progressbar" accessibilityLabel="Analyse de l’étiquette en cours">
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={styles.row}>
          <Animated.View style={[styles.labelBar, { opacity: pulse }]} />
          <Animated.View style={[styles.valueBlock, { opacity: pulse }]} />
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
