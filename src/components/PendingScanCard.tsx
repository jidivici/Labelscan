/**
 * PendingScanCard — one row of the home screen's "En cours" section (workflow v1).
 *
 * Fixed height (PENDING_CARD_HEIGHT) so the FlatList's getItemLayout stays exact with
 * these cards in the header. The card is tappable while EXTRACTING as well as when
 * ready → opens Review live (3-step progress box + fields filling in). An errored card
 * shows a Réessayer button instead.
 *
 * Deletion (workflow v2.1) = LEFT SWIPE revealing a red Supprimer — the exact same
 * gesture as ArticleCard, so the whole home list shares ONE delete affordance. Works
 * in every state (a bad shot can be dropped mid-extraction). Confirm mentions the
 * draft when one exists.
 *
 * Layout: [uniform thumbnail] · [état + hint text] · [profile completeness gauge].
 * carries the live score; color signals state (accent=en cours, vert=à valider,
 * rouge=erreur). Sober by design — no progress bar, no confidence.
 */

import React, { useCallback, useEffect } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { PulseDot } from './PulseDot';
import { CompletenessGauge } from './CompletenessGauge';
import { scanStepFromStatus } from '../services/scanSteps';
import type { PendingScan } from '../services/scanQueue';
import { RotatedPhoto } from './RotatedPhoto';
import { colors, spacing, radius, typography } from '../theme';

const PENDING_CARD_HEIGHT = 88;
// Swipe-to-delete geometry — SAME values as ArticleCard so both card types answer the
// identical gesture identically.
const DELETE_WIDTH = 80;
const SWIPE_THRESHOLD = -60;

export interface PendingScanCardProps {
  scan: PendingScan;
  /** Filled canonical field count (0..17) for the gauge. */
  filledCount: number;
  /** Closed contract size for the scan's server-assigned trade. */
  totalFieldCount: number;
  /** Whether the product name (commercial_designation) is known yet. */
  nameKnown: boolean;
  onOpen: (scan: PendingScan) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  /** True only for the one pending card currently revealing Supprimer. */
  swipeOpen: boolean;
  /** Makes this card the sole open swipe and closes the previously open card. */
  onSwipeStart: (id: string) => void;
  /** Clears the parent's open-swipe ownership when this card returns home. */
  onSwipeClose: (id: string) => void;
}

export const PendingScanCard = React.memo(function PendingScanCard({
  scan,
  filledCount,
  totalFieldCount,
  nameKnown,
  onOpen,
  onRetry,
  onDiscard,
  swipeOpen,
  onSwipeStart,
  onSwipeClose,
}: PendingScanCardProps) {
  const { activeLabel, openable } = scanStepFromStatus(scan.status, scan.ocrDone === true);
  const errored = scan.status === 'submit_error' || scan.status === 'extract_error';
  const extracting = scan.status === 'extracting';
  const submitting = scan.status === 'submitting';
  const ready = scan.status === 'ready';
  const requiresRecapture = scan.status === 'recapture_required';
  const waitingForSync = scan.reviewSyncStatus === 'pending';
  // A "ready" scan is only truly "à valider" once all profile fields are filled.
  // Below that it stays "en cours" and reads "À compléter" — it is NOT an article yet.
  const complete = ready && filledCount === totalFieldCount;
  const displayLabel = waitingForSync
    ? 'En attente de synchronisation'
    : ready && !complete
      ? 'À compléter'
      : activeLabel;
  // Highlight the active label (accent) while the product name is still unknown.
  const highlightLabel = extracting && !nameKnown;
  // The gauge is the live profile-completeness cue.
  const showGauge = extracting || ready;

  const translateX = useSharedValue(0);

  // The parent owns which scan may expose Supprimer. When another card starts a
  // horizontal swipe, this prop turns false and the previously open card springs
  // back into place instead of leaving two destructive actions visible.
  useEffect(() => {
    if (!swipeOpen) translateX.value = withSpring(0);
  }, [swipeOpen, translateX]);

  const hasDraft = scan.edits != null && Object.keys(scan.edits).length > 0;
  const confirmDiscard = useCallback(() => {
    Alert.alert(
      'Supprimer cette étiquette ?',
      hasDraft
        ? 'La photo, la tentative en cours et les modifications saisies seront effacées.'
        : 'La photo et la tentative en cours seront effacées.',
      [
        {
          text: 'Annuler',
          style: 'cancel',
          // Close the swipe back — same behavior as ArticleCard's cancel.
          onPress: () => {
            translateX.value = withSpring(0);
            onSwipeClose(scan.id);
          },
        },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            onSwipeClose(scan.id);
            onDiscard(scan.id);
          },
        },
      ],
    );
  }, [onDiscard, onSwipeClose, scan.id, hasDraft, translateX]);

  // Left-swipe reveal — replicated from ArticleCard (activeOffsetX keeps vertical
  // FlatList scrolling and the card tap intact).
  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onStart(() => {
      runOnJS(onSwipeStart)(scan.id);
    })
    .onUpdate((e) => {
      if (e.translationX < 0) {
        translateX.value = Math.max(e.translationX, -DELETE_WIDTH);
      }
    })
    .onEnd((e) => {
      const shouldOpen = e.translationX < SWIPE_THRESHOLD;
      translateX.value = withSpring(shouldOpen ? -DELETE_WIDTH : 0);
      if (!shouldOpen) runOnJS(onSwipeClose)(scan.id);
    });

  const cardAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const handlePress = useCallback(() => {
    if (openable) onOpen(scan);
  }, [openable, onOpen, scan]);

  const hint = waitingForSync
    ? 'Touchez pour relancer l’envoi'
    : requiresRecapture
    ? 'Touchez pour reprendre la photo'
    : ready
    ? complete
      ? 'Touchez pour valider'
      : 'Touchez pour compléter'
    : extracting
      ? 'Touchez pour suivre'
      : 'Envoi en cours';

  return (
    <View style={styles.wrapper}>
      {/* Delete reveal — identical to ArticleCard's. */}
      <Pressable
        style={styles.deleteReveal}
        onPress={confirmDiscard}
        android_ripple={{ color: colors.onError }}
        accessibilityRole="button"
        accessibilityLabel="Supprimer cette étiquette"
      >
        <MaterialCommunityIcons name="trash-can-outline" size={24} color={colors.onError} />
        <Text style={[typography.labelMedium, { color: colors.onError, marginTop: 2 }]}>
          Supprimer
        </Text>
      </Pressable>

      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.card, cardAnimStyle]}>
          <Pressable
            onPress={handlePress}
            disabled={!openable}
            style={styles.pressable}
            android_ripple={openable ? { color: colors.primaryContainer } : undefined}
            accessibilityRole={openable ? 'button' : undefined}
            accessibilityLabel={
              requiresRecapture
                ? 'Ouvrir les instructions pour reprendre la photo'
                : openable
                  ? 'Ouvrir la revue de cette étiquette'
                  : activeLabel
            }
          >
            <View style={styles.thumbnail}>
              <RotatedPhoto
                source={{ uri: scan.photoUri }}
                style={styles.thumbnailImage}
                resizeMode="cover"
                halfTurn={scan.photoRotationDegrees === 180}
                baseRotationDegrees={scan.photoBaseRotationDegrees ?? -90}
              />
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
                  {/* Réessayer stays a button; deletion is the uniform left swipe now. */}
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
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.statusRow}>
                    {submitting ? (
                      <PulseDot size={8} color={colors.primary} />
                    ) : (
                      <View
                        style={[
                          styles.dot,
                          {
                            backgroundColor: requiresRecapture
                              ? colors.error
                              : complete && !waitingForSync
                                ? colors.success
                                : colors.primary,
                          },
                        ]}
                      />
                    )}
                    <Text
                      style={[
                        typography.titleSmall,
                        styles.statusLabel,
                        complete && !waitingForSync && styles.statusLabelReady,
                        requiresRecapture && styles.errorLabel,
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

            {errored ? null : requiresRecapture ? (
              <MaterialCommunityIcons name="camera-retake-outline" size={24} color={colors.error} />
            ) : waitingForSync ? (
              <PulseDot size={10} color={colors.primary} />
            ) : showGauge ? (
              <CompletenessGauge filled={filledCount} total={totalFieldCount} loading={extracting} />
            ) : (
              <PulseDot size={10} color={colors.primary} />
            )}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  // Swipe wrapper — same construction as ArticleCard: a fixed-height slot holding the
  // red delete reveal underneath and the animated card above (getItemLayout intact).
  wrapper: {
    height: PENDING_CARD_HEIGHT,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  deleteReveal: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: DELETE_WIDTH,
    backgroundColor: colors.error,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    height: PENDING_CARD_HEIGHT,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  pressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
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
});
