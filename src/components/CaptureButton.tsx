/**
 * CaptureButton — Camera shutter button
 * Agent 1 spec: outer ring 72px, inner circle 56px, Pressable with spring animation
 */

import React, { useCallback } from 'react';
import { StyleSheet, View, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { colors, radius, sizing } from '../theme';

interface CaptureButtonProps {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}

// Typed explicitly to preserve prop inference through the animated wrapper
const AnimatedPressable = Animated.createAnimatedComponent(Pressable) as typeof Pressable;

export function CaptureButton({
  onPress,
  loading = false,
  disabled = false,
}: CaptureButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // scale is a stable shared-value ref — deps are empty intentionally
  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.88, { stiffness: 200, damping: 12 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { stiffness: 200, damping: 12 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isDisabled = disabled || loading;

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={isDisabled}
        style={styles.outer}
        // Transparent ripple — spring animation is the primary feedback (Agent 1 Rule 3).
        // No spinner: the capture lock is momentary now (the heavy work runs in the
        // background), so the shutter stays a clean, always-ready white circle.
        android_ripple={{ color: 'transparent' }}
      >
        <View style={styles.inner} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: {
    width: sizing.captureButtonOuter,
    height: sizing.captureButtonOuter,
    borderRadius: radius.full,
    borderWidth: sizing.captureButtonBorder,
    borderColor: colors.onPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    width: sizing.captureButtonInner,
    height: sizing.captureButtonInner,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
