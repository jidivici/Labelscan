/**
 * ScanStepper — the 3-step counter for one queued scan (workflow v1, home screen):
 *   Photo envoyée → Extraction → À valider
 * Same visual language as ExtractionProgress (PulseDot for the active step, an
 * animated check for a done one) so the whole capture→review flow speaks one
 * idiom. Sober by design: no percentages, no confidence, a compact horizontal
 * row of 3 dots (not the vertical banner — this lives inside a list card).
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PulseDot } from './PulseDot';
import type { ScanStepStatus } from '../services/scanSteps';
import { colors, spacing, typography } from '../theme';

function StepDot({ status }: { status: ScanStepStatus }) {
  if (status === 'done') {
    return <MaterialCommunityIcons name="check-circle" size={14} color={colors.primary} />;
  }
  if (status === 'active') {
    return <PulseDot size={10} />;
  }
  if (status === 'error') {
    return <MaterialCommunityIcons name="alert-circle" size={14} color={colors.error} />;
  }
  return <View style={styles.dotPending} />;
}

export interface ScanStepperProps {
  steps: [ScanStepStatus, ScanStepStatus, ScanStepStatus];
  activeLabel: string;
}

export function ScanStepper({ steps, activeLabel }: ScanStepperProps) {
  const hasError = steps.includes('error');
  return (
    <View style={styles.root}>
      <View style={styles.dots}>
        {steps.map((status, i) => (
          <React.Fragment key={i}>
            <StepDot status={status} />
            {i < steps.length - 1 ? <View style={styles.connector} /> : null}
          </React.Fragment>
        ))}
      </View>
      <Text
        style={[typography.labelMedium, styles.label, hasError && styles.labelError]}
        numberOfLines={1}
      >
        {activeLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xs,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connector: {
    width: 16,
    height: 1,
    backgroundColor: colors.outlineVariant,
    marginHorizontal: 4,
  },
  dotPending: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.outline,
    backgroundColor: 'transparent',
  },
  label: {
    color: colors.onSurfaceVariant,
  },
  labelError: {
    color: colors.error,
  },
});
