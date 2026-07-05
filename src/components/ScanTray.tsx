/**
 * ScanTray — workflow v1: replaces the blocking photo-review overlay on the camera.
 *
 * The shutter now submits in the background and the operator keeps shooting; this
 * is the only trace of that activity left on the camera screen — a small stack of
 * the most recent thumbnails with a count badge and a pulse while anything is still
 * submitting/extracting. Tapping it returns to the home screen, where the "En cours"
 * section (PendingScanCard/ScanStepper) shows the full per-scan detail and errors.
 * The camera stays a pure viewfinder: no error state is rendered here by design.
 */

import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { useScanQueue } from '../hooks/useScanQueue';
import { PulseDot } from './PulseDot';
import { colors, radius, spacing, typography } from '../theme';

const MAX_THUMBNAILS = 3;
const THUMB_SIZE = 40;
const THUMB_OFFSET = 10;

export interface ScanTrayProps {
  onPress: () => void;
}

export function ScanTray({ onPress }: ScanTrayProps) {
  const { scans } = useScanQueue();

  if (scans.length === 0) return null;

  const recent = [...scans].slice(-MAX_THUMBNAILS).reverse();
  const active = scans.some((s) => s.status === 'submitting' || s.status === 'extracting');

  return (
    <Pressable
      onPress={onPress}
      style={styles.root}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`${scans.length} étiquette${scans.length > 1 ? 's' : ''} en cours — revenir à l’accueil`}
    >
      <View style={styles.stack}>
        {recent.map((scan, i) => (
          <Image
            key={scan.id}
            source={{ uri: scan.photoUri }}
            style={[
              styles.thumb,
              { left: i * THUMB_OFFSET, zIndex: recent.length - i },
            ]}
          />
        ))}
      </View>
      <View style={styles.badge}>
        {active ? <PulseDot size={8} color={colors.onPrimary} /> : null}
        <Text style={[typography.labelSmall, styles.badgeText]}>{scans.length}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stack: {
    width: THUMB_SIZE + (MAX_THUMBNAILS - 1) * THUMB_OFFSET,
    height: THUMB_SIZE,
  },
  thumb: {
    position: 'absolute',
    top: 0,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.onPrimary,
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    gap: 3,
  },
  badgeText: {
    color: colors.onPrimary,
  },
});
