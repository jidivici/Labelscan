/**
 * FlashOverlay — White flash on capture (Agent 1 spec §8.1)
 * 80ms fade-in → 40ms hold → 200ms fade-out
 */

import React, { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';

export interface FlashOverlayRef {
  trigger: () => void;
}

export const FlashOverlay = forwardRef<FlashOverlayRef>((_, ref) => {
  const opacity = useSharedValue(0);

  useImperativeHandle(ref, () => ({
    trigger() {
      opacity.value = withSequence(
        withTiming(0.9, { duration: 80, easing: Easing.out(Easing.quad) }),
        withTiming(0.9, { duration: 40 }),
        withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) })
      );
    },
  }));

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return <Animated.View style={[StyleSheet.absoluteFill, styles.flash, animatedStyle]} pointerEvents="none" />;
});

FlashOverlay.displayName = 'FlashOverlay';

const styles = StyleSheet.create({
  flash: {
    backgroundColor: '#FFFFFF',
    zIndex: 99,
  },
});
