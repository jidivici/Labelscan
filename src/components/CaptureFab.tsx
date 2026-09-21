/**
 * CaptureFab — floating action button that launches the capture module.
 *
 * Bottom-right, primary-filled circle with a camera icon. Deliberately NO badge or
 * notification dot: a red "alert" bubble on the primary capture action read as a
 * problem when it only carried a benign saved-article count (audit §6.1, "Clean UI").
 */

import React, { useCallback } from 'react';
import { StyleSheet, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, radius, elevation } from '../theme';

interface CaptureFabProps {
  onPress: () => void;
  /** Distance from the bottom edge (accounts for the safe-area inset). */
  bottomInset?: number;
}

const FAB_SIZE = 64;

export function CaptureFab({ onPress, bottomInset = 0 }: CaptureFabProps) {
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
});
