/**
 * ExtractionProgress — the 3-step "box" shown on the Review screen while a scan is
 * still being processed:
 *   Photo envoyée ✓  ·  Lecture du texte…  ·  Analyse de l'espèce…
 *
 * The active step is a gently pulsing accent dot (never a spinner); a completed step
 * "pops" a check. Steps advance on an estimated timer until the backend's real
 * `ocr_done` transit (Tier 3) pins the stage to the LLM step. Sober card styling:
 * hairline border on surface, no percentages, no confidence.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PulseDot } from './PulseDot';
import { extractionStage } from '../services/extractionStage';
import { colors, spacing, radius, typography } from '../theme';

type StepStatus = 'done' | 'active' | 'pending';

/** The check "pops" (scale 0.4→1 + fade) the moment a step completes. */
function AnimatedCheck() {
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(pop, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.back(1.6)),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [pop]);
  return (
    <Animated.View
      style={{
        opacity: pop,
        transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
      }}
    >
      {/* Loading uses the accent BLUE end-to-end (green is reserved for a saved state). */}
      <MaterialCommunityIcons name="check-circle" size={16} color={colors.primary} />
    </Animated.View>
  );
}

const STEPS = [
  { key: 'upload', label: 'Photo envoyée' },
  { key: 'ocr', label: 'Lecture du texte' },
  { key: 'llm', label: 'Analyse de l’espèce' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

function StepRow({ label, status }: { label: string; status: StepStatus }) {
  return (
    <View style={styles.row}>
      <View style={styles.indicator}>
        {status === 'done' ? (
          <AnimatedCheck />
        ) : status === 'active' ? (
          <PulseDot size={11} color={colors.primary} />
        ) : (
          <View style={[styles.dot, styles.dotPending]} />
        )}
      </View>
      <Text
        style={[
          typography.bodyMedium,
          styles.label,
          status === 'pending' && { color: colors.onSurfaceVariant },
          status === 'active' && { color: colors.onSurface, fontFamily: 'Inter_600SemiBold' },
        ]}
      >
        {status === 'active' ? `${label}…` : label}
      </Text>
    </View>
  );
}

export function ExtractionProgress({
  startedAt,
  ready,
  ocrDone = false,
}: {
  startedAt: number;
  ready: boolean;
  /** Real Tier 3 `ocr_done` transit — pins the stage to 'llm' (no more estimating). */
  ocrDone?: boolean;
}) {
  // Re-render every ~400 ms so the estimated stage advances; stop once the run lands.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (ready) return;
    const id = setInterval(() => setTick((t) => t + 1), 400);
    return () => clearInterval(id);
  }, [ready]);

  const stage = extractionStage(Date.now() - startedAt, ready, ocrDone);
  const statusFor = (key: StepKey): StepStatus => {
    if (key === 'upload') return 'done'; // upload finished during the background submit
    if (key === 'ocr') return stage === 'ocr' ? 'active' : 'done';
    // llm
    if (stage === 'ready') return 'done';
    return stage === 'llm' ? 'active' : 'pending';
  };

  return (
    <View style={styles.box}>
      {STEPS.map((s) => (
        <StepRow key={s.key} label={s.label} status={statusFor(s.key)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Sober bordered card (hairline on surface) — not a heavy filled bandeau.
  box: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 5,
  },
  indicator: {
    width: 18,
    alignItems: 'center',
  },
  label: {
    color: colors.onSurface,
    marginLeft: spacing.sm,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotPending: {
    borderWidth: 1.5,
    borderColor: colors.outline,
    backgroundColor: 'transparent',
  },
});
