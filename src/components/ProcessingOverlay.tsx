/**
 * ProcessingOverlay — Full-screen modal overlay while a capture is processed.
 * Copy is caller-provided (message + subtitle) so it can describe either the
 * backend extraction path or the legacy on-device OCR path.
 */

import React from 'react';
import { View, Text, StyleSheet, Modal } from 'react-native';
import { PulseDot } from './PulseDot';
import { colors, spacing, radius, typography, elevation } from '../theme';

interface ProcessingOverlayProps {
  visible: boolean;
  message?: string;
  subtitle?: string;
}

export function ProcessingOverlay({
  visible,
  message = 'Traitement…',
  subtitle = 'Cela peut prendre quelques secondes',
}: ProcessingOverlayProps) {
  return (
    <Modal transparent animationType="fade" visible={visible}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <PulseDot size={18} />
          <Text style={[typography.titleMedium, styles.title]}>{message}</Text>
          {subtitle ? (
            <Text style={[typography.bodySmall, styles.subtitle]}>{subtitle}</Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    minWidth: 220,
    ...elevation[5],
  },
  title: {
    color: colors.onSurface,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.onSurfaceVariant,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
});
