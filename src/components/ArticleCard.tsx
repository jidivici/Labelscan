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
import { colors, spacing, radius, typography } from '../theme';

interface ArticleCardProps {
  article: Article;
  onDelete: (id: string) => void;
  /** Open the full immutable record (the "lot") for this article. */
  onOpen?: (article: Article) => void;
}

export const CARD_HEIGHT = 88;
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

  // Card content: "nom de produit - lot" on top, registration date (DD/MM/YYYY) below.
  const lot = article.fields.find((f) => f.field_name === 'batch_number')?.value ?? '';
  const title =
    [commonName(article), lot].filter((s) => s.length > 0).join(' - ') ||
    article.barcode_raw ||
    'Sans nom';
  const dateStr = formatDateShort(article.saved_at);

  const confirmDelete = useCallback(() => {
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
            {/* Thumbnail */}
            <View style={styles.thumbnail}>
              {article.photo_uri ? (
                <Image
                  source={{ uri: article.photo_uri }}
                  style={styles.thumbnailImage}
                  resizeMode="cover"
                />
              ) : (
                <MaterialCommunityIcons
                  name="file-document-outline"
                  size={32}
                  color={colors.onSurfaceVariant}
                />
              )}
            </View>

            {/* Text stack */}
            <View style={styles.textStack}>
              <Text
                style={[typography.titleMedium, { color: colors.onSurface }]}
                numberOfLines={2}
              >
                {title}
              </Text>
              <View style={styles.metaRow}>
                <MaterialCommunityIcons
                  name="calendar-outline"
                  size={12}
                  color={colors.onSurfaceVariant}
                />
                <Text
                  style={[
                    typography.labelSmall,
                    { color: colors.onSurfaceVariant, marginLeft: spacing.xs },
                  ]}
                >
                  {dateStr}
                </Text>
              </View>
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
  },
  pressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  // Uniform 56×56 thumbnail (same as PendingScanCard): same size, radius and border
  // everywhere an image appears in a list.
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginRight: spacing.md,
    flexShrink: 0,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  textStack: {
    flex: 1,
    gap: spacing.xs,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
