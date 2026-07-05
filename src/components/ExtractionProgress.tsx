/**
 * Staged extraction-progress CASCADE (Tier 5 — docs/LATENCY-REVIEW.md §5).
 *
 * Replaces the spinning wheel during the OCR+LLM wait with a vertical CASCADE OF STATES:
 *   Photo envoyée ✓  ·  Lecture du texte…  ·  Analyse de l'espèce…
 * The active step is a gently pulsing dot — never a spinner. The upload is already done by
 * the time Review mounts (Tier 1 overlap), so "Photo envoyée" starts complete; the next steps
 * advance on an estimated timer (services/extractionStage). When the backend later exposes a
 * real "OCR fait" interim state (Tier 3), the SAME cascade binds to actual transitions.
 *
 * Sober by design (Clean UI): no percentages, no confidence, no wheel.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PulseDot } from './PulseDot';
import { extractionStage } from '../services/extractionStage';
import { colors, spacing, radius, typography } from '../theme';

type StepStatus = 'done' | 'active' | 'pending';

/** The check "pops" (scale 0.4→1 + fade, ~200 ms) the moment a step completes —
 * a real transition now that Tier 3/4 report actual stage changes. */
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
          <PulseDot />
        ) : (
          <View style={[styles.dot, styles.dotPending]} />
        )}
      </View>
      <Text
        style={[
          typography.bodyMedium,
          styles.label,
          status === 'pending' && { color: colors.onSurfaceVariant },
          status === 'active' && { color: colors.onSurface, fontWeight: '600' },
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
    if (key === 'upload') return 'done'; // upload finished during the photo-review overlap (Tier 1)
    if (key === 'ocr') return stage === 'ocr' ? 'active' : 'done';
    // llm
    if (stage === 'ready') return 'done';
    return stage === 'llm' ? 'active' : 'pending';
  };

  return (
    <View style={styles.banner}>
      {STEPS.map((s) => (
        <StepRow key={s.key} label={s.label} status={statusFor(s.key)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
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
    width: 13,
    height: 13,
    borderRadius: 7,
  },
  dotPending: {
    borderWidth: 1.5,
    borderColor: colors.outline,
    backgroundColor: 'transparent',
  },
});
