/**
 * FrameOverlay — label-placement guide drawn over the camera viewfinder.
 *
 * A large centered window (where the operator places the whole label) with a light
 * focus veil outside it, corner brackets and a discreet "barcode detected" badge.
 *
 * The window is both the placement guide and the crop region: the full photo is
 * captured, then cropped to this frame before it is sent to the backend (see
 * CameraScreen.computeFrameCrop). Capture happens only when the user taps the
 * shutter (no auto-capture).
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { colors, spacing, radius, typography } from '../theme';

export type FrameState = 'ready' | 'barcodeFound' | 'capturing' | 'error';

interface FrameOverlayProps {
  state: FrameState;
  /** Absolute geometry of the placement window (computed by the screen). */
  frameTop: number;
  frameLeft: number;
  frameWidth: number;
  frameHeight: number;
}

const CORNER_SIZE = 32;
const CORNER_THICKNESS = 4;
const SCRIM = 'rgba(0,0,0,0.18)';
const CAPTION_BACKGROUND = 'rgba(0,0,0,0.58)';

// High-contrast brackets (white) at rest for sunlight; tinted by state otherwise.
const bracketColor: Record<FrameState, string> = {
  ready: colors.onPrimary,
  barcodeFound: colors.success,
  capturing: colors.primary,
  error: colors.error,
};

export function FrameOverlay({
  state,
  frameTop,
  frameLeft,
  frameWidth,
  frameHeight,
}: FrameOverlayProps) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (state === 'ready') {
      // Slow breathe to signal "live — aim here". Static on every other state.
      pulse.value = withRepeat(
        withTiming(0.7, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      );
    } else {
      pulse.value = withTiming(1, { duration: 150 });
    }
  }, [state, pulse]);

  const bracketsAnim = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const color = bracketColor[state];
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* A light focus veil preserves the full photo instead of creating black bars. */}
      <View style={[styles.scrim, { top: 0, left: 0, right: 0, height: frameTop }]} />
      <View style={[styles.scrim, { top: frameTop + frameHeight, left: 0, right: 0, bottom: 0 }]} />
      <View style={[styles.scrim, { top: frameTop, left: 0, width: frameLeft, height: frameHeight }]} />
      <View style={[styles.scrim, { top: frameTop, left: frameLeft + frameWidth, right: 0, height: frameHeight }]} />

      {/* Frame window: corner brackets + barcode badge */}
      <View
        style={{
          position: 'absolute',
          top: frameTop,
          left: frameLeft,
          width: frameWidth,
          height: frameHeight,
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, bracketsAnim]}>
          <View style={[styles.cornerTL, { borderColor: color }]} />
          <View style={[styles.cornerTR, { borderColor: color }]} />
          <View style={[styles.cornerBL, { borderColor: color }]} />
          <View style={[styles.cornerBR, { borderColor: color }]} />
        </Animated.View>

        {state === 'barcodeFound' ? (
          <View style={styles.badge}>
            <MaterialCommunityIcons name="barcode-scan" size={14} color={colors.onPrimary} />
            <Text style={[typography.labelMedium, styles.badgeText]}>Code-barres détecté</Text>
          </View>
        ) : null}
      </View>

      {state === 'error' ? (
        <View style={[styles.caption, { top: frameTop + frameHeight + spacing.md }]}>
          <Text style={[typography.labelLarge, styles.captionText]}>Échec — réessayez</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    backgroundColor: SCRIM,
  },
  cornerTL: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderTopLeftRadius: radius.lg,
  },
  cornerTR: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderTopRightRadius: radius.lg,
  },
  cornerBL: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderBottomLeftRadius: radius.lg,
  },
  cornerBR: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderBottomRightRadius: radius.lg,
  },
  badge: {
    position: 'absolute',
    bottom: spacing.sm,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.success,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  badgeText: {
    color: colors.onPrimary,
  },
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  captionText: {
    color: colors.onPrimary,
    backgroundColor: CAPTION_BACKGROUND,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    overflow: 'hidden',
    textAlign: 'center',
  },
});
