/**
 * PhotoViewerModal — full-screen photo viewer (workflow v1, §6.3).
 *
 * Lets the operator inspect the label photo at full resolution: pinch to zoom
 * (clamped ×1–5), pan while zoomed, double-tap to toggle zoom, tap the close
 * button to dismiss. Opens from the cover-cropped photo card in Review and the
 * article detail — the crop there never loses content because THIS view always
 * shows the full photo (`resizeMode="contain"`).
 *
 * react-native-gesture-handler + react-native-reanimated drive the gestures, while
 * expo-image reuses the protected source from memory. RN's `Modal` renders its
 * content in a separate native root, so gesture-handler needs its OWN
 * `GestureHandlerRootView` inside the modal (the app-root one at App.tsx does
 * not cover it) — a known requirement, not a workaround.
 */

import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView, GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme';
import { PHOTO_DISPLAY_ROTATION, type PhotoBaseRotationDegrees } from './photoOrientation';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const INITIAL_SCALE = 1.4;
const AnimatedImage = Animated.createAnimatedComponent(Image);

export interface PhotoViewerModalProps {
  visible: boolean;
  photoUri: string | null | undefined;
  headers?: Record<string, string>;
  allowHalfTurn?: boolean;
  halfTurn?: boolean;
  onHalfTurn?: () => void;
  /** -90 for historical captures; 0 for landscape captures already stored upright. */
  baseRotationDegrees?: PhotoBaseRotationDegrees;
  onClose: () => void;
}

export function PhotoViewerModal({
  visible,
  photoUri,
  headers,
  allowHalfTurn = false,
  halfTurn = false,
  onHalfTurn,
  baseRotationDegrees = -90,
  onClose,
}: PhotoViewerModalProps) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const quarterTurn = baseRotationDegrees === -90;
  const scale = useSharedValue(INITIAL_SCALE);
  const savedScale = useSharedValue(INITIAL_SCALE);
  const translateX = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const reset = () => {
    scale.value = withTiming(INITIAL_SCALE);
    savedScale.value = INITIAL_SCALE;
    translateX.value = withTiming(0);
    savedTranslateX.value = 0;
    translateY.value = withTiming(0);
    savedTranslateY.value = 0;
  };

  // Every open starts slightly zoomed and centered. This keeps the label readable
  // immediately without carrying zoom/pan state over from the previous photo.
  useEffect(() => {
    if (visible) {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, photoUri]);

  const pinch = Gesture.Pinch().onUpdate((e) => {
    scale.value = Math.min(Math.max(savedScale.value * e.scale, MIN_SCALE), MAX_SCALE);
  }).onEnd(() => {
    savedScale.value = scale.value;
    if (scale.value <= MIN_SCALE) {
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
    }
  });

  const pan = Gesture.Pan().onUpdate((e) => {
    // Panning only makes sense once zoomed in — otherwise the image just re-centers.
    if (savedScale.value <= MIN_SCALE) return;
    translateX.value = savedTranslateX.value + e.translationX;
    translateY.value = savedTranslateY.value + e.translationY;
  }).onEnd(() => {
    savedTranslateX.value = translateX.value;
    savedTranslateY.value = translateY.value;
  });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const target = savedScale.value > INITIAL_SCALE ? INITIAL_SCALE : DOUBLE_TAP_SCALE;
      scale.value = withTiming(target);
      savedScale.value = target;
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
    });

  const composed = Gesture.Simultaneous(pinch, pan);
  const gesture = Gesture.Race(doubleTap, composed);

  // Keep the same left-facing orientation in the full-screen viewer and thumbnails.
  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      ...(quarterTurn ? [{ rotate: PHOTO_DISPLAY_ROTATION }] : []),
      ...(halfTurn ? [{ rotate: '180deg' as const }] : []),
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  if (!photoUri) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <GestureDetector gesture={gesture}>
          <AnimatedImage
            source={{ uri: photoUri, headers }}
            style={[
              styles.image,
              {
                left: quarterTurn ? (windowWidth - windowHeight) / 2 : 0,
                top: quarterTurn ? (windowHeight - windowWidth) / 2 : 0,
                width: quarterTurn ? windowHeight : windowWidth,
                height: quarterTurn ? windowWidth : windowHeight,
              },
              imageStyle,
            ]}
            contentFit="contain"
            cachePolicy="memory"
            priority="high"
            recyclingKey={photoUri}
            transition={120}
          />
        </GestureDetector>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={[styles.closeButton, { top: insets.top + spacing.sm }]}
          accessibilityRole="button"
          accessibilityLabel="Fermer la photo"
        >
          <View style={styles.closeCircle}>
            <MaterialCommunityIcons name="close" size={22} color={colors.onPrimary} />
          </View>
        </Pressable>
        {allowHalfTurn ? (
          <Pressable
            onPress={() => {
              onHalfTurn?.();
            }}
            hitSlop={12}
            style={[styles.rotateButton, { top: insets.top + spacing.sm }]}
            accessibilityRole="button"
            accessibilityLabel="Tourner la photo d’un demi-tour"
          >
            <View style={styles.closeCircle}>
              <MaterialCommunityIcons name="rotate-left" size={22} color={colors.onPrimary} />
            </View>
          </Pressable>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  image: {
    position: 'absolute',
  },
  closeButton: {
    position: 'absolute',
    right: spacing.md,
  },
  rotateButton: {
    position: 'absolute',
    right: spacing.md + 52,
  },
  closeCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
