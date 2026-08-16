import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { Image, type ImageContentFit, type ImageProps } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PHOTO_DISPLAY_ROTATION, type PhotoBaseRotationDegrees } from './photoOrientation';
import { colors } from '../theme';

interface RotatedPhotoProps {
  source: ImageProps['source'];
  style?: StyleProp<ViewStyle>;
  resizeMode?: ImageContentFit;
  accessibilityLabel?: ImageProps['accessibilityLabel'];
  halfTurn?: boolean;
  priority?: ImageProps['priority'];
  /** -90 for historical captures; 0 for landscape captures already stored upright. */
  baseRotationDegrees?: PhotoBaseRotationDegrees;
}

/**
 * A photo frame with explicit storage-orientation metadata. Dimensions cannot
 * distinguish old and new files because both are landscape.
 */
export function RotatedPhoto({
  source,
  style,
  resizeMode = 'cover',
  accessibilityLabel,
  halfTurn = false,
  priority = 'normal',
  baseRotationDegrees = -90,
}: RotatedPhotoProps) {
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const quarterTurn = baseRotationDegrees === -90;
  const recyclingKey = useMemo(() => {
    if (typeof source === 'number' || typeof source === 'string') return String(source);
    if (Array.isArray(source)) return JSON.stringify(source);
    if (source && typeof source === 'object' && 'uri' in source) return source.uri ?? 'photo';
    return 'photo';
  }, [source]);

  useEffect(() => {
    setLoadState('loading');
  }, [recyclingKey]);

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
          contentFit={resizeMode}
          accessibilityLabel={accessibilityLabel}
          allowDownscaling
          cachePolicy="memory"
          priority={priority}
          recyclingKey={recyclingKey}
          transition={160}
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('error')}
          style={{
            position: 'absolute',
            left: quarterTurn ? (frame.width - frame.height) / 2 : 0,
            top: quarterTurn ? (frame.height - frame.width) / 2 : 0,
            width: quarterTurn ? frame.height : frame.width,
            height: quarterTurn ? frame.width : frame.height,
            transform: [
              ...(quarterTurn ? [{ rotate: PHOTO_DISPLAY_ROTATION }] : []),
              ...(halfTurn ? [{ rotate: '180deg' as const }] : []),
            ],
          }}
        />
      ) : null}
      {loadState === 'loading' ? (
        <View pointerEvents="none" style={styles.feedback}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : null}
      {loadState === 'error' ? (
        <View pointerEvents="none" style={styles.feedback}>
          <MaterialCommunityIcons name="image-off-outline" size={24} color={colors.onSurfaceVariant} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    backgroundColor: colors.surfaceVariant,
  },
  feedback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
