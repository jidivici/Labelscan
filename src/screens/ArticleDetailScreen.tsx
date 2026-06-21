/**
 * ArticleDetailScreen — the immutable record (the "lot") for one saved article.
 *
 * Read-only display: lot number, save date, author in the headline, then a clean
 * per-field list (name + value). No "à vérifier" flag here — uncertainty is surfaced
 * only at REVIEW time (enregistrement), not on the face of the saved record. No source
 * captions, OCR evidence, warnings, or validation status tags either. No red anywhere.
 *
 * Immutability (ADR-0003/0004): this record is append-only. A re-extraction is a NEW
 * run, never an overwrite. Human corrections made at Review time are preserved via
 * the `edited` flag; the original machine output stays on raw_extraction_run.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { getArticleById } from '../services/storage';
import { Article, ArticleField } from '../types/Article';
import { formatDateShort } from '../services/dates';
import { fieldLabelFr, displayFieldValue } from '../services/fieldLabels';
import { formatFaoDisplay } from '../services/faoDisplay';
import type { ArticlesStackParamList } from '../navigation/RootNavigator';
import { colors, spacing, radius, typography, elevation } from '../theme';

type DetailRoute = RouteProp<ArticlesStackParamList, 'ArticleDetail'>;
type DetailNav = StackNavigationProp<ArticlesStackParamList, 'ArticleDetail'>;

// Single placeholder for an absent value. Literal em dash on purpose — JSX text
// must never carry \uXXXX escapes (they render literally), see fieldLabels notes.
const EM_DASH = "—";

function HeadlineItem({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string | null | undefined;
  emphasis?: boolean;
}) {
  const hasValue = !!value && value.length > 0;
  return (
    <View style={styles.headlineItem}>
      <Text style={[typography.labelSmall, styles.overline]}>{label}</Text>
      <Text
        selectable
        style={[
          emphasis ? typography.titleMedium : typography.bodyLarge,
          styles.headlineValue,
          !hasValue && styles.placeholderValue,
        ]}
      >
        {hasValue ? value : EM_DASH}
      </Text>
    </View>
  );
}

function DetailField({ field }: { field: ArticleField }) {
  const value = displayFieldValue(field.field_name, field.value);
  const isEmpty = value == null || value.length === 0;

  return (
    <View style={styles.field}>
      <Text style={[typography.labelSmall, styles.overline, styles.fieldName]}>
        {fieldLabelFr(field.field_name)}
      </Text>
      <Text
        selectable
        style={[typography.bodyMedium, styles.fieldValue, isEmpty && styles.placeholderValue]}
      >
        {isEmpty ? EM_DASH : value}
      </Text>
    </View>
  );
}

export function ArticleDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<DetailNav>();
  const route = useRoute<DetailRoute>();
  const { articleId } = route.params;

  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const found = await getArticleById(articleId);
      if (active) {
        setArticle(found);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [articleId]);

  const handleBack = useCallback(() => navigation.goBack(), [navigation]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!article) {
    return (
      <View style={[styles.centered, { padding: spacing.lg }]}>
        <MaterialCommunityIcons name="file-remove-outline" size={40} color={colors.onSurfaceVariant} />
        <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant, marginTop: spacing.sm }]}>
          Ce lot est introuvable.
        </Text>
        <Pressable onPress={handleBack} style={styles.backTextButton} accessibilityRole="button">
          <Text style={[typography.labelLarge, { color: colors.primary }]}>Retour</Text>
        </Pressable>
      </View>
    );
  }

  const lot = article.fields.find((f) => f.field_name === 'batch_number');
  // Precise catch zone (FAO major-area number) — surfaced prominently when extracted.
  const fao = article.fields.find((f) => f.field_name === 'FAO_area');

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <View style={styles.photoContainer}>
        {article.photo_uri ? (
          <Image source={{ uri: article.photo_uri }} style={styles.photo} resizeMode="contain" />
        ) : (
          <View style={[styles.photo, styles.photoPlaceholder]}>
            <MaterialCommunityIcons name="file-document-outline" size={48} color={colors.onSurfaceVariant} />
          </View>
        )}
        <View style={[styles.photoAppBar, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={handleBack}
            hitSlop={12}
            android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
            accessibilityRole="button"
            accessibilityLabel="Retour"
          >
            <MaterialCommunityIcons name="arrow-left" size={24} color={colors.onPrimary} />
          </Pressable>
          <Text style={[typography.titleLarge, { color: colors.onPrimary }]}>Détail du lot</Text>
          <View style={{ width: 24 }} />
        </View>
      </View>

      <ScrollView
        style={styles.contentCard}
        contentContainerStyle={styles.contentInner}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headlineCard}>
          <View style={styles.headlineGroup}>
            <HeadlineItem label="Numéro de lot" value={lot?.value} emphasis />
            {fao?.value ? <HeadlineItem label="Zone de pêche (FAO)" value={formatFaoDisplay(fao.value)} /> : null}
          </View>
          <View style={styles.headlineDivider} />
          <View style={styles.headlineGroup}>
            <HeadlineItem label="Date d'enregistrement" value={formatDateShort(article.saved_at)} />
            <HeadlineItem label="Utilisateur" value={article.saved_by} />
          </View>
        </View>

        <Text style={[typography.labelSmall, styles.overline, styles.sectionLabel]}>
          Champs ({article.fields.length})
        </Text>
        {article.fields.length === 0 ? (
          <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
            Aucun champ extrait.
          </Text>
        ) : (
          article.fields.map((f) => (
            <DetailField key={f.field_name} field={f} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backTextButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  photoContainer: {
    height: 220,
    position: 'relative',
    backgroundColor: colors.onSurface,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoAppBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  contentCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    marginTop: -radius.lg,
    ...elevation[2],
  },
  contentInner: {
    padding: spacing.lg,
    paddingBottom: spacing['2xl'],
  },
  headlineCard: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    marginBottom: spacing.lg,
  },
  // One stacked group (lot + FAO, or date + user) with an even rhythm between items.
  headlineGroup: {
    gap: spacing.sm,
  },
  headlineDivider: {
    height: 1,
    backgroundColor: colors.outlineVariant,
    marginVertical: spacing.md,
  },
  headlineItem: {
    flexShrink: 1,
  },
  headlineValue: {
    color: colors.onSurface,
  },
  // Shared treatment for every uppercase label (headline, section header, field name)
  // so the whole screen reads on one typographic system, aligned to a single left edge.
  overline: {
    color: colors.onSurfaceVariant,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  sectionLabel: {
    marginBottom: spacing.xs,
  },
  field: {
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  fieldName: {
    flexShrink: 1,
  },
  // Label and value intentionally share the same left edge (no indent) — vertical alignment.
  fieldValue: {
    color: colors.onSurface,
  },
  // Absent value ("—"): kept in place to document what the label lacked, but visually quiet
  // so present information stands out.
  placeholderValue: {
    color: colors.outline,
  },
});
