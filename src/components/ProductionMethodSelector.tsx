import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { canonicalizeFinalReviewValue } from '../services/finalReviewValidation';
import { colors, radius, spacing, typography } from '../theme';

const OPTIONS = [
  { canonical: 'wild_caught', label: 'Pêche sauvage' },
  { canonical: 'farmed', label: 'Élevage' },
] as const;

/** French-only control; the save boundary converts the label back to the API enum. */
export function ProductionMethodSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = canonicalizeFinalReviewValue('production_method', value);

  return (
    <View style={styles.options} accessibilityRole="radiogroup">
      {OPTIONS.map((option) => {
        const active = selected === option.canonical;
        return (
          <Pressable
            key={option.canonical}
            onPress={() => onChange(option.label)}
            style={[styles.option, active && styles.optionSelected]}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
          >
            <Text style={[typography.labelMedium, styles.label, active && styles.labelSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  option: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: radius.full,
    backgroundColor: colors.background,
  },
  optionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryContainer,
  },
  label: {
    color: colors.onSurfaceVariant,
  },
  labelSelected: {
    color: colors.onPrimaryContainer,
  },
});
