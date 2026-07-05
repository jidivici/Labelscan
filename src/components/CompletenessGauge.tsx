/**
 * CompletenessGauge — compact circular gauge showing the running n/17 field score.
 *
 * A ring whose interior fills with an animated WATER LEVEL as fields land (OCR + LLM);
 * the `n/17` score sits in the center. While `loading` the level gently waves (a sober
 * "still working" cue — never a spinner); when loading ends it settles at the final
 * ratio. Lives in a home "En cours" card's trailing slot; the whole card is tappable
 * (including while extracting), so the gauge doubles as an "open the review" affordance.
 *
 * One accent color, no percentages beyond /17, no confidence — sober by design.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { CANONICAL_FIELD_COUNT } from '../services/fieldCompleteness';
import { colors, typography } from '../theme';

export interface CompletenessGaugeProps {
  /** Number of canonical fields already filled (0..CANONICAL_FIELD_COUNT). */
  filled: number;
  /** While the extraction is still running the water level gently waves. */
  loading?: boolean;
  /** Pixel diameter of the gauge (default 46 — fits PendingScanCard). */
  size?: number;
  accessibilityLabel?: string;
}

export function CompletenessGauge({
  filled,
  loading = false,
  size = 46,
  accessibilityLabel,
}: CompletenessGaugeProps) {
  const ratio = Math.max(0, Math.min(1, filled / CANONICAL_FIELD_COUNT));

  const level = useRef(new Animated.Value(ratio)).current;
  const wavePhase = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(level, {
      toValue: ratio,
      duration: 600,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // drives layout height (clipped by the ring mask)
    }).start();
  }, [ratio, level]);

  useEffect(() => {
    if (!loading) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(wavePhase, { toValue: 1, duration: 1100, useNativeDriver: false, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(wavePhase, { toValue: 0, duration: 1100, useNativeDriver: false, easing: Easing.inOut(Easing.sin) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [loading, wavePhase]);

  // The wave bob: ±6% of the gauge height, only while loading.
  const waterHeight = Animated.add(
    level,
    loading ? wavePhase.interpolate({ inputRange: [0, 1], outputRange: [-0.06, 0.06] }) : 0,
  );

  const ringStyle = useMemo(
    () => ({
      width: size,
      height: size,
      borderRadius: size / 2,
    }),
    [size],
  );

  const a11y =
    accessibilityLabel ?? `Extraction ${filled} sur ${CANONICAL_FIELD_COUNT} champs${loading ? ', en cours' : ''}`;

  return (
    <View
      style={[styles.root, ringStyle]}
      accessibilityRole="progressbar"
      accessibilityLabel={a11y}
      accessibilityValue={{ min: 0, max: CANONICAL_FIELD_COUNT, now: filled }}
    >
      {/* Water fill — clipped to the circle by overflow:hidden + borderRadius. */}
      <Animated.View style={[styles.water, { height: Animated.multiply(waterHeight, size) }]} />
      {/* Score — centered over the fill. */}
      <View style={styles.scoreWrap}>
        <Text style={[typography.labelSmall, styles.score]}>
          {filled}
          <Text style={styles.scoreDenom}>/{CANONICAL_FIELD_COUNT}</Text>
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surfaceContainer,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  water: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.primaryContainer,
  },
  scoreWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  score: {
    color: colors.onSurface,
    fontWeight: '700',
    lineHeight: 14,
  },
  scoreDenom: {
    color: colors.onSurfaceVariant,
    fontWeight: '500',
  },
});
