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

import { PHOTO_DISPLAY_ROTATION } from './photoOrientation';

interface RotatedPhotoProps {
  source: ImageSourcePropType;
  style?: StyleProp<ViewStyle>;
  resizeMode?: ImageResizeMode;
  accessibilityLabel?: ImageProps['accessibilityLabel'];
  halfTurn?: boolean;
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
}: RotatedPhotoProps) {
  const [frame, setFrame] = useState({ width: 0, height: 0 });

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
            left: (frame.width - frame.height) / 2,
            top: (frame.height - frame.width) / 2,
            width: frame.height,
            height: frame.width,
            transform: [{ rotate: PHOTO_DISPLAY_ROTATION }, ...(halfTurn ? [{ rotate: '180deg' as const }] : [])],
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
