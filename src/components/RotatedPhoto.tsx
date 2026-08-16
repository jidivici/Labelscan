import React, { useState } from 'react';
import {
  Image,
  type ImageProps,
  type ImageResizeMode,
  type ImageSourcePropType,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { photoDisplayRotation, type PhotoBaseRotationDegrees } from './photoOrientation';

interface RotatedPhotoProps {
  source: ImageSourcePropType;
  style?: StyleProp<ViewStyle>;
  resizeMode?: ImageResizeMode;
  accessibilityLabel?: ImageProps['accessibilityLabel'];
  halfTurn?: boolean;
  /** -90 for historical raw captures; 0 for crops already rotated upright. */
  baseRotationDegrees?: PhotoBaseRotationDegrees;
}

/**
 * A photo frame whose image dimensions are swapped before the left rotation.
 * This prevents the rotated bitmap from becoming a narrow band in rectangular frames.
 */
export function RotatedPhoto({
  source,
  style,
  resizeMode = 'cover',
  accessibilityLabel,
  halfTurn = false,
  baseRotationDegrees = -90,
}: RotatedPhotoProps) {
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const quarterTurn = baseRotationDegrees !== 0;

  return (
    <View
      style={[styles.frame, style]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width !== frame.width || height !== frame.height) setFrame({ width, height });
      }}
    >
      {frame.width > 0 && frame.height > 0 ? (
        <Image
          source={source}
          resizeMode={resizeMode}
          accessibilityLabel={accessibilityLabel}
          style={{
            position: 'absolute',
            left: quarterTurn ? (frame.width - frame.height) / 2 : 0,
            top: quarterTurn ? (frame.height - frame.width) / 2 : 0,
            width: quarterTurn ? frame.height : frame.width,
            height: quarterTurn ? frame.width : frame.height,
            transform: [
              ...(quarterTurn ? [{ rotate: photoDisplayRotation(baseRotationDegrees) }] : []),
              ...(halfTurn ? [{ rotate: '180deg' as const }] : []),
            ],
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
  },
});
