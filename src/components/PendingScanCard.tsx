/**
 * PendingScanCard — one row of the home screen's "En cours" section (workflow v1).
 *
 * Fixed height (PENDING_CARD_HEIGHT) so the FlatList's getItemLayout stays exact
 * with these cards in the header (see ArticleListScreen — same discipline as
 * ArticleCard's CARD_HEIGHT, audit §7.1). Tapping a 'ready' card opens Review;
 * an errored card shows Réessayer/Supprimer instead of the stepper.
 */

import React, { useCallback } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ScanStepper } from './ScanStepper';
import { scanStepFromStatus } from '../services/scanSteps';
import type { PendingScan } from '../services/scanQueue';
import { colors, spacing, radius, typography, elevation } from '../theme';

export const PENDING_CARD_HEIGHT = 88;

export interface PendingScanCardProps {
  scan: PendingScan;
  onOpen: (scan: PendingScan) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}

export const PendingScanCard = React.memo(function PendingScanCard({
  scan,
  onOpen,
  onRetry,
  onDiscard,
}: PendingScanCardProps) {
  const { steps, activeLabel, openable } = scanStepFromStatus(scan.status, scan.ocrDone === true);
  const errored = scan.status === 'submit_error' || scan.status === 'extract_error';

  const confirmDiscard = useCallback(() => {
    Alert.alert('Supprimer cette étiquette ?', 'La photo et la tentative en cours seront effacées.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: () => onDiscard(scan.id) },
    ]);
  }, [onDiscard, scan.id]);

  const handlePress = useCallback(() => {
    if (openable) onOpen(scan);
  }, [openable, onOpen, scan]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={!openable}
      style={styles.card}
      android_ripple={openable ? { color: colors.primaryContainer } : undefined}
      accessibilityRole={openable ? 'button' : undefined}
      accessibilityLabel={openable ? 'Ouvrir la revue de cette étiquette' : activeLabel}
    >
      <View style={styles.thumbnail}>
        <Image source={{ uri: scan.photoUri }} style={styles.thumbnailImage} resizeMode="cover" />
      </View>

      <View style={styles.body}>
        {errored ? (
          <>
            <Text style={[typography.labelMedium, styles.errorLabel]} numberOfLines={1}>
              {activeLabel}
            </Text>
            <View style={styles.actions}>
              <Pressable
                onPress={() => onRetry(scan.id)}
                style={styles.actionButton}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Réessayer"
              >
                <MaterialCommunityIcons name="refresh" size={16} color={colors.primary} />
                <Text style={[typography.labelMedium, styles.actionText]}>Réessayer</Text>
              </Pressable>
              <Pressable
                onPress={confirmDiscard}
                style={styles.actionButton}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Supprimer"
              >
                <MaterialCommunityIcons name="trash-can-outline" size={16} color={colors.error} />
                <Text style={[typography.labelMedium, styles.actionTextDestructive]}>Supprimer</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <ScanStepper steps={steps} activeLabel={activeLabel} />
        )}
      </View>

      {openable ? (
        <MaterialCommunityIcons name="chevron-right" size={22} color={colors.onSurfaceVariant} />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    height: PENDING_CARD_HEIGHT,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    ...elevation[1],
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceVariant,
    overflow: 'hidden',
    marginRight: spacing.md,
    flexShrink: 0,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  errorLabel: {
    color: colors.error,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionText: {
    color: colors.primary,
  },
  actionTextDestructive: {
    color: colors.error,
  },
});
