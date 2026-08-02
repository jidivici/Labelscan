/**
 * EmptyState — Shown when the home catalogue is empty.
 *
 * The illustration is deliberately a quiet scan field rather than a
 * generic empty-state drawing: it makes the home feel like part of LabelScan
 * before the operator has scanned their first label.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from '../theme';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

interface EmptyStateProps {
  onAction: () => void;
  title?: string;
  description?: string;
  actionLabel?: string;
  actionIconName?: IconName;
  showAction?: boolean;
}

function EmptyIllustration() {
  return (
    <View style={styles.illustration}>
      <View style={styles.illustrationGroup}>
        <View style={styles.ambientGlow} />
        <Animated.View entering={FadeInDown.duration(360)} style={styles.logoMark}>
          <View style={[styles.corner, styles.cornerTopLeft]} />
          <View style={[styles.corner, styles.cornerTopRight]} />
          <View style={[styles.corner, styles.cornerBottomLeft]} />
          <View style={[styles.corner, styles.cornerBottomRight]} />
          <View style={styles.barcode}>
            <View style={[styles.bar, styles.barTall]} />
            <View style={[styles.bar, styles.barThin]} />
            <View style={[styles.bar, styles.barMedium]} />
            <View style={[styles.bar, styles.barTall]} />
            <View style={[styles.bar, styles.barThin]} />
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

export function EmptyState({
  onAction,
  title = 'Aucun arrivage',
  description = 'Scannez votre première étiquette.',
  actionLabel = 'Scanner une étiquette',
  actionIconName = 'camera-outline',
  showAction = true,
}: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <EmptyIllustration />

      <View style={styles.copy}>
        <Text style={[typography.headlineSmall, styles.headline]}>
          {title}
        </Text>

        <Text style={[typography.bodyMedium, styles.body]}>
          {description}
        </Text>
      </View>

      {showAction ? (
        <View style={styles.ctaWrapper}>
          <Pressable
            onPress={onAction}
            style={({ pressed }) => [
              styles.cta,
              pressed && styles.ctaPressed,
            ]}
            android_ripple={{ color: colors.primaryContainer }}
          >
            <MaterialCommunityIcons
              name={actionIconName}
              size={18}
              color={colors.onPrimary}
            />
            <Text numberOfLines={1} style={[typography.labelLarge, styles.ctaText]}>
              {actionLabel}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing['2xl'],
    paddingBottom: spacing['3xl'],
  },
  illustration: {
    width: 190,
    height: 188,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  illustrationGroup: {
    width: 190,
    height: 188,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ambientGlow: {
    position: 'absolute',
    width: 172,
    height: 172,
    borderRadius: radius.full,
    backgroundColor: '#E5F1EE',
    borderWidth: 1,
    borderColor: '#D6E7E2',
  },
  logoMark: {
    width: 152,
    height: 152,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#A1AFB8',
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 1.5,
    borderLeftWidth: 1.5,
    borderTopLeftRadius: radius.sm,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 1.5,
    borderRightWidth: 1.5,
    borderTopRightRadius: radius.sm,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 1.5,
    borderLeftWidth: 1.5,
    borderBottomLeftRadius: radius.sm,
  },
  cornerBottomRight: {
    right: 0,
    bottom: 0,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderBottomRightRadius: radius.sm,
  },
  barcode: {
    position: 'absolute',
    height: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  bar: {
    width: 9,
    borderRadius: 1,
    backgroundColor: colors.secondary,
  },
  barTall: {
    height: 68,
  },
  barMedium: {
    width: 10,
    height: 56,
  },
  barThin: {
    width: 6,
    height: 68,
  },
  copy: {
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  headline: {
    color: colors.onSurface,
    textAlign: 'center',
  },
  body: {
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    maxWidth: 264,
  },
  ctaWrapper: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    minWidth: 220,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.xl,
  },
  ctaPressed: {
    opacity: 0.85,
  },
  ctaText: {
    color: colors.onPrimary,
    flexShrink: 1,
  },
});
