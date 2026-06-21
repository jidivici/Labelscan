/**
 * EmptyState — Shown when article list is empty
 * Agent 1 spec: centered illustration + headline + body + CTA
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Animated, {
  FadeIn,
  ZoomIn,
} from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, spacing, radius, typography, elevation } from '../theme';

interface EmptyStateProps {
  onCapture: () => void;
}

export function EmptyState({ onCapture }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <Animated.View entering={ZoomIn.delay(0).springify().damping(14)}>
        <View style={styles.iconContainer}>
          <MaterialCommunityIcons
            name="camera-outline"
            size={64}
            color={colors.primary}
          />
        </View>
      </Animated.View>

      <Animated.Text
        entering={FadeIn.delay(150).duration(300)}
        style={[typography.headlineSmall, styles.headline]}
      >
        Aucun article
      </Animated.Text>

      <Animated.Text
        entering={FadeIn.delay(200).duration(300)}
        style={[typography.bodyMedium, styles.body]}
      >
        Touchez le bouton ci-dessous pour scanner{'\n'}votre première étiquette.
      </Animated.Text>

      <Animated.View entering={FadeIn.delay(300).duration(300)}>
        <Pressable
          onPress={onCapture}
          style={({ pressed }) => [
            styles.cta,
            pressed && styles.ctaPressed,
          ]}
          android_ripple={{ color: colors.primaryContainer }}
        >
          <MaterialCommunityIcons
            name="camera-outline"
            size={18}
            color={colors.onPrimary}
            style={{ marginRight: spacing.sm }}
          />
          <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
            Scanner une étiquette
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing['2xl'],
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    ...elevation[1],
  },
  headline: {
    color: colors.onSurface,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  body: {
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    height: 48,
    ...elevation[2],
  },
  ctaPressed: {
    opacity: 0.85,
  },
});
