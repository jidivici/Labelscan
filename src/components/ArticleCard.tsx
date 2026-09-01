/**
 * ArticleCard — List item for the article list
 * Agent 1 spec: horizontal layout, thumbnail + text stack, swipe-to-delete via gesture
 */

import React, { useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Pressable,
  Alert,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import {
  GestureDetector,
  Gesture,
} from 'react-native-gesture-handler';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Article } from '../types/Article';
import { formatDateShort } from '../services/dates';
import { commonName } from '../services/articleGrouping';
import { displayFieldValue, displayFinalFieldValue } from '../services/fieldLabels';
import { businessProfileFor } from '../services/businessProfiles';
import { colors, spacing, radius, typography } from '../theme';
import { RotatedPhoto } from './RotatedPhoto';
import { useAuthenticatedImageSource } from '../hooks/useAuthenticatedImageSource';

interface ArticleCardProps {
  article: Article;
  onDelete?: (id: string) => void;
  /** Open the full immutable record (the "lot") for this article. */
  onOpen?: (article: Article) => void;
}

export const CARD_HEIGHT = 136;
const DELETE_WIDTH = 80;
const SWIPE_THRESHOLD = -60;

// Memoized: in a long FlatList, a parent state change (search, delete) must NOT re-render
// every card. Re-renders only when article/onDelete/onOpen change — the parent keeps those
// stable via useCallback (audit §7.1).
export const ArticleCard = React.memo(function ArticleCard({
  article,
  onDelete,
  onOpen,
}: ArticleCardProps) {
  const translateX = useSharedValue(0);
  const scale = useSharedValue(1);
  const photoSource = useAuthenticatedImageSource(article.photo_uri);
  const showFao = businessProfileFor(article.trade_code).fields.includes('FAO_area');

  const fieldValue = (name: string) =>
    article.fields.find((field) => field.field_name === name)?.value?.trim() ?? '';
  const lot = fieldValue('batch_number');
  const fao = fieldValue('FAO_area');
  const scientificName = fieldValue('scientific_name');
  const producer = fieldValue('producer_name') || fieldValue('reseller_brand');
  const productionMethod = displayFieldValue('production_method', fieldValue('production_method'));
  const origin = fieldValue('origin_country');
  const title = commonName(article) || article.barcode_raw || 'NC';
  const description =
    [scientificName || producer, productionMethod, origin].filter(Boolean).join(' · ') ||
    'NC';
  const dateStr = formatDateShort(article.saved_at);

  const confirmDelete = useCallback(() => {
    if (!onDelete) return;
    Alert.alert('Supprimer l’article', 'Action irréversible.', [
      {
        text: 'Annuler',
        style: 'cancel',
        onPress: () => {
          translateX.value = withSpring(0);
        },
      },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: () => onDelete(article.id),
      },
    ]);
  }, [article.id, onDelete, translateX]);

  const panGesture = Gesture.Pan()
    .enabled(Boolean(onDelete))
    .activeOffsetX([-10, 10])
    .onUpdate((e) => {
      // Only allow left swipe
      if (e.translationX < 0) {
        translateX.value = Math.max(e.translationX, -DELETE_WIDTH);
      }
    })
    .onEnd((e) => {
      if (e.translationX < SWIPE_THRESHOLD) {
        translateX.value = withSpring(-DELETE_WIDTH);
      } else {
        translateX.value = withSpring(0);
      }
    });

  const cardAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { scale: scale.value }],
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97, { damping: 18, stiffness: 250, mass: 0.8 });
  }, [scale]);
  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1.0, { damping: 18, stiffness: 250, mass: 0.8 });
  }, [scale]);

  return (
    <View style={styles.wrapper}>
      {/* Delete reveal */}
      {onDelete ? (
        <Pressable
          style={styles.deleteReveal}
          onPress={confirmDelete}
          android_ripple={{ color: colors.onError }}
        >
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={24}
            color={colors.onError}
          />
          <Text style={[typography.labelMedium, { color: colors.onError, marginTop: 2 }]}>
            Supprimer
          </Text>
        </Pressable>
      ) : null}

      {/* Swipeable card */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.card, cardAnimStyle]}>
          <Pressable
            onPress={() => onOpen?.(article)}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={styles.pressable}
            android_ripple={{ color: colors.primaryContainer }}
            accessibilityRole="button"
            accessibilityLabel="Ouvrir le détail du lot"
          >
            {/* Product image stays in one fixed frame for a stable list rhythm. */}
            <View style={styles.thumbnail}>
              {photoSource ? (
                <RotatedPhoto
                  source={photoSource}
                  style={[
                    styles.thumbnailImage,
                  ]}
                  resizeMode="cover"
                  halfTurn={article.photo_rotation_degrees === 180}
                  baseRotationDegrees={article.photo_base_rotation_degrees ?? -90}
                />
              ) : (
                <MaterialCommunityIcons
                  name="food-variant"
                  size={34}
                  color={colors.primary}
                />
              )}
            </View>

            {/* Every information slot has a fixed height, so cards never reflow when
                optional product fields are missing or unusually long. */}
            <View style={styles.textStack}>
              <Text
                style={[typography.titleMedium, styles.title]}
                numberOfLines={2}
              >
                {title}
              </Text>

              <Text
                style={[
                  typography.bodySmall,
                  styles.description,
                  scientificName && styles.scientificName,
                ]}
                numberOfLines={1}
              >
                {description}
              </Text>

              <View style={styles.chipRow}>
                <View style={styles.metaChip}>
                  <Text style={[typography.labelSmall, styles.metaChipText]} numberOfLines={1}>
                    Lot {displayFinalFieldValue('batch_number', lot || null)}
                  </Text>
                </View>
                {showFao ? (
                  <View style={styles.metaChip}>
                    <Text style={[typography.labelSmall, styles.metaChipText]} numberOfLines={1}>
                      FAO {displayFinalFieldValue('FAO_area', fao || null)}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.footerRow}>
                <View style={styles.metaRow}>
                  <MaterialCommunityIcons
                    name="calendar-check-outline"
                    size={13}
                    color={colors.onSurfaceVariant}
                  />
                  <Text style={[typography.labelSmall, styles.dateText]}>
                    {dateStr}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.chevronSlot}>
              <MaterialCommunityIcons
                name="chevron-right"
                size={20}
                color={colors.outline}
              />
            </View>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    height: CARD_HEIGHT,
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
  // Hairline-bordered card, identical treatment to PendingScanCard so the whole
  // home list reads as one homogeneous column (no mixed radii / shadows).
  card: {
    height: CARD_HEIGHT,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    overflow: 'hidden',
  },
  pressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.sm,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  thumbnail: {
    width: 92,
    height: 118,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginRight: 12,
    flexShrink: 0,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  textStack: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
    paddingVertical: 0,
  },
  title: {
    color: colors.onSurface,
  },
  description: {
    color: colors.onSurfaceVariant,
    height: 16,
  },
  scientificName: {
    fontStyle: 'italic',
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    height: 22,
    alignItems: 'center',
  },
  metaChip: {
    minWidth: 0,
    maxWidth: '56%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
  },
  metaChipText: {
    color: colors.onPrimaryContainer,
    flexShrink: 1,
  },
  missingMeta: {
    color: colors.outline,
  },
  footerRow: {
    marginTop: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  dateText: {
    color: colors.onSurfaceVariant,
  },
  chevronSlot: {
    width: 24,
    height: '100%',
    alignItems: 'flex-end',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
