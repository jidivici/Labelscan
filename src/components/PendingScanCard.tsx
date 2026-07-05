/**
 * PendingScanCard — one row of the home screen's "En cours" section (workflow v1).
 *
 * Fixed height (PENDING_CARD_HEIGHT) so the FlatList's getItemLayout stays exact with
 * these cards in the header. The card is tappable while EXTRACTING as well as when
 * ready → opens Review live (3-step progress box + fields filling in). An errored card
 * shows Réessayer/Supprimer instead.
 *
 * Layout: [uniform thumbnail] · [état + hint text] · [circular n/17 gauge]. The gauge
 * carries the live score; color signals state (blue=en cours, vert=à valider,
 * rouge=erreur). Sober by design — no progress bar, no confidence.
 */

import React, { useCallback } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PulseDot } from './PulseDot';
import { CompletenessGauge } from './CompletenessGauge';
import { scanStepFromStatus } from '../services/scanSteps';
import { CANONICAL_FIELD_COUNT } from '../services/fieldCompleteness';
import type { PendingScan } from '../services/scanQueue';
import { colors, spacing, radius, typography } from '../theme';

export const PENDING_CARD_HEIGHT = 88;

export interface PendingScanCardProps {
  scan: PendingScan;
  /** Filled canonical field count (0..17) for the gauge. */
  filledCount: number;
  /** Whether the product name (commercial_designation) is known yet. */
  nameKnown: boolean;
  onOpen: (scan: PendingScan) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}

export const PendingScanCard = React.memo(function PendingScanCard({
  scan,
  filledCount,
  nameKnown,
  onOpen,
  onRetry,
  onDiscard,
}: PendingScanCardProps) {
  const { activeLabel, openable } = scanStepFromStatus(scan.status, scan.ocrDone === true);
  const errored = scan.status === 'submit_error' || scan.status === 'extract_error';
  const extracting = scan.status === 'extracting';
  const submitting = scan.status === 'submitting';
  const ready = scan.status === 'ready';
  // Workflow v2: a "ready" scan is only truly "à valider" once all 17 fields are filled.
  // Below that it stays "en cours" and reads "À compléter" — it is NOT an article yet.
  const complete = ready && filledCount === CANONICAL_FIELD_COUNT;
  const displayLabel = ready && !complete ? 'À compléter' : activeLabel;
  // Highlight the active label (accent) while the product name is still unknown.
  const highlightLabel = extracting && !nameKnown;
  // The gauge is the live "n/17" cue: it waves while extracting, settles when ready.
  const showGauge = extracting || ready;

  const hasDraft = scan.edits != null && Object.keys(scan.edits).length > 0;
  const confirmDiscard = useCallback(() => {
    Alert.alert(
      'Supprimer cette étiquette ?',
      hasDraft
        ? 'La photo, la tentative en cours et les modifications saisies seront effacées.'
        : 'La photo et la tentative en cours seront effacées.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => onDiscard(scan.id) },
      ],
    );
  }, [onDiscard, scan.id, hasDraft]);

  const handlePress = useCallback(() => {
    if (openable) onOpen(scan);
  }, [openable, onOpen, scan]);

  const hint = ready
    ? complete
      ? 'Touchez pour valider'
      : 'Touchez pour compléter'
    : extracting
      ? 'Touchez pour suivre'
      : 'Envoi en cours';

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
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: colors.error }]} />
              <Text style={[typography.titleSmall, styles.errorLabel]} numberOfLines={1}>
                {activeLabel}
              </Text>
            </View>
            <View style={styles.actions}>
              <Pressable
                onPress={() => onRetry(scan.id)}
                style={styles.actionButton}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Réessayer"
              >
                <MaterialCommunityIcons name="refresh" size={15} color={colors.primary} />
                <Text style={[typography.labelMedium, styles.actionText]}>Réessayer</Text>
              </Pressable>
              <Pressable
                onPress={confirmDiscard}
                style={styles.actionButton}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Supprimer"
              >
                <MaterialCommunityIcons name="trash-can-outline" size={15} color={colors.error} />
                <Text style={[typography.labelMedium, styles.actionTextDestructive]}>Supprimer</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={styles.statusRow}>
              {submitting ? (
                <PulseDot size={8} color={colors.primary} />
              ) : (
                <View style={[styles.dot, { backgroundColor: complete ? colors.success : colors.primary }]} />
              )}
              <Text
                style={[
                  typography.titleSmall,
                  styles.statusLabel,
                  complete && styles.statusLabelReady,
                  highlightLabel && styles.statusLabelHighlight,
                ]}
                numberOfLines={1}
              >
                {displayLabel}
              </Text>
            </View>
            <Text style={[typography.bodySmall, styles.hintText]} numberOfLines={1}>
              {hint}
            </Text>
          </>
        )}
      </View>

      {errored ? null : showGauge ? (
        <CompletenessGauge filled={filledCount} loading={extracting} />
      ) : (
        <PulseDot size={10} color={colors.primary} />
      )}

      {/* Discard is available on EVERY non-errored state too (workflow v2): a bad shot
          can be dropped mid-extraction, and a "ready" card — à compléter OU à valider —
          can be removed without opening the review. Same confirm as the error path. */}
      {errored ? null : (
        <Pressable
          onPress={confirmDiscard}
          hitSlop={10}
          style={styles.trailingDiscard}
          accessibilityRole="button"
          accessibilityLabel="Supprimer cette étiquette"
        >
          <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.onSurfaceVariant} />
        </Pressable>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    height: PENDING_CARD_HEIGHT,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    overflow: 'hidden',
    flexShrink: 0,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    color: colors.onSurface,
    flexShrink: 1,
  },
  statusLabelReady: {
    color: colors.success,
  },
  statusLabelHighlight: {
    color: colors.primary,
  },
  errorLabel: {
    color: colors.error,
    flexShrink: 1,
  },
  hintText: {
    color: colors.onSurfaceVariant,
    marginLeft: spacing.md + 2,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginLeft: spacing.md + 2,
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
  // Compact trailing trash (non-errored cards) — quiet gray, generous hitSlop; sits
  // after the gauge/pulse without changing the card's fixed height.
  trailingDiscard: {
    paddingLeft: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
