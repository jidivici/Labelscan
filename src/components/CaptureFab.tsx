/**
 * CaptureFab — floating action button that launches the capture module.
 *
 * Bottom-right, primary-filled circle with a camera icon and a small badge
 * "bubble" in the top-right corner. The badge shows a short count (e.g. the number
 * of saved articles) when provided; otherwise it renders as a discreet accent dot
 * so the affordance still reads as the live, primary action.
 */

import React, { useCallback } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, radius, typography, elevation } from '../theme';

interface CaptureFabProps {
  onPress: () => void;
  /** Optional count rendered in the badge bubble. Omitted/0 → discreet dot. */
  badgeCount?: number;
  /** Distance from the bottom edge (accounts for the safe-area inset). */
  bottomInset?: number;
}

const FAB_SIZE = 64;

export function CaptureFab({ onPress, badgeCount = 0, bottomInset = 0 }: CaptureFabProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // scale is a stable shared-value ref — empty deps intentional.
  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.9, { stiffness: 220, damping: 14 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { stiffness: 220, damping: 14 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showCount = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? '99+' : String(badgeCount);

  return (
    <Animated.View
      style={[styles.wrapper, { bottom: bottomInset + 24 }, animatedStyle]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={styles.fab}
        android_ripple={{ color: colors.primaryContainer, borderless: false }}
        accessibilityRole="button"
        accessibilityLabel="Scanner une étiquette"
      >
        <MaterialCommunityIcons name="camera-plus" size={28} color={colors.onPrimary} />
        <View style={[styles.badge, showCount ? styles.badgeCount : styles.badgeDot]}>
          {showCount ? (
            <Text style={[typography.labelSmall, styles.badgeText]} numberOfLines={1}>
              {badgeLabel}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    right: 24,
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation[4],
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: colors.error,
    borderWidth: 2,
    borderColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeDot: {
    width: 14,
    height: 14,
    borderRadius: radius.full,
  },
  badgeCount: {
    minWidth: 20,
    height: 20,
    borderRadius: radius.full,
    paddingHorizontal: 4,
  },
  badgeText: {
    color: colors.onError,
    lineHeight: 14,
  },
});
