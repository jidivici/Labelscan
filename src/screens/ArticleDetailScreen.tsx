/**
 * ArticleDetailScreen — the saved record (the "lot") for one article.
 *
 * Reads in the SAME field order as the registration screen (services/fieldOrder.ts) so the
 * app is consistent end-to-end. Sober identity header (lot + when/who), then a modern card
 * list of every field. Fields are editable IN PLACE (pencil → edit state) — workflow v1:
 * ALL 17 fields, including GS1-exact ones (lot/DLC/weight/GTIN/packaging); the operator
 * stays in charge. Saving an edit writes the human override to the authoritative
 * backend (source='human', force_gs1 tagged automatically for barcode-derived fields),
 * then refreshes the shared catalogue.
 *
 * Clean UI (CLAUDE.md): no "Édité"/"Modifié" tag, no confidence score, no red. Who/when an
 * edit happened lives only in the header meta, not as per-field badges.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
  Image,
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
import { commonName } from '../services/articleGrouping';
import {
  businessProfileFor,
  inferTradeCodeFromFields,
  type FieldGroup,
} from '../services/businessProfiles';
import {
  parseTemp,
  formatTemp,
  validateTempRange,
  parsePrice,
  formatPrice,
} from '../services/inputMasks';
import { submitFieldOverrides } from '../services/fieldOverrideSubmit';
import { queryClient } from '../services/queryClient';
import { PhotoViewerModal } from '../components/PhotoViewerModal';
import type { ArticlesStackParamList } from '../navigation/RootNavigator';
import { colors, spacing, radius, typography, elevation } from '../theme';
import { useAuth } from '../context/AuthContext';

type DetailRoute = RouteProp<ArticlesStackParamList, 'ArticleDetail'>;
type DetailNav = StackNavigationProp<ArticlesStackParamList, 'ArticleDetail'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// A quiet leading icon per field — gives each row a modern, anchored look (and fills the
// otherwise-bare list). Purely decorative; unknown fields fall back to a generic tag.
const FIELD_ICON: Record<string, IconName> = {
  commercial_designation: 'food-variant',
  scientific_name: 'flask-outline',
  producer_name: 'factory',
  reseller_brand: 'store-outline',
  production_method: 'waves',
  fishing_gear_or_farming_method: 'anchor',
  FAO_area: 'map-marker-outline',
  origin_country: 'flag-outline',
  health_mark: 'shield-check-outline',
  batch_number: 'identifier',
  expiry_date: 'calendar-alert',
  packaging_date: 'calendar-outline',
  storage_temperature: 'thermometer',
  weight: 'scale-balance',
  allergens: 'alert-circle-outline',
  price: 'currency-eur',
  gtin: 'barcode',
  animal_species: 'cow',
  animal_category: 'shape-outline',
  cut_name: 'knife',
  birth_country: 'baby-face-outline',
  rearing_country: 'barn',
  slaughter_country: 'map-marker-outline',
  cutting_country: 'map-marker-outline',
  slaughterhouse_approval: 'certificate-outline',
  cutting_plant_approval: 'certificate-outline',
  product_family: 'food-outline',
  manufacturer_name: 'factory',
  ingredients: 'format-list-bulleted',
  additives: 'flask-outline',
  preparation_date: 'calendar-edit',
  conditioning_type: 'package-variant-closed',
  storage_mode: 'snowflake',
  use_instructions: 'information-outline',
  reheating_instructions: 'microwave',
};

const FIELD_GROUP_ICON: Record<string, IconName> = {
  identity: 'food-variant',
  provenance: 'map-marker-radius-outline',
  traceability: 'shield-check-outline',
  haccp: 'clipboard-check-outline',
  commercial: 'scale-balance',
  other: 'dots-horizontal-circle-outline',
};

function fieldIcon(name: string): IconName {
  return FIELD_ICON[name] ?? 'tag-outline';
}

interface DisplayFieldGroup {
  id: string;
  title: string;
  fields: ArticleField[];
}

/** Group saved fields by shared business logic; unexpected legacy fields stay visible. */
function groupFields(fields: ArticleField[], fieldGroups: readonly FieldGroup[]): DisplayFieldGroup[] {
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const groups: DisplayFieldGroup[] = [];

  for (const group of fieldGroups) {
    const groupItems: ArticleField[] = [];
    for (const name of group.fields) {
      const field = byName.get(name);
      if (field) {
        groupItems.push(field);
        byName.delete(name);
      }
    }
    if (groupItems.length > 0) {
      groups.push({ id: group.id, title: group.title, fields: groupItems });
    }
  }

  const extraFields = [...byName.values()];
  if (extraFields.length > 0) {
    groups.push({ id: 'other', title: 'Informations complémentaires', fields: extraFields });
  }

  return groups;
}

// ── In-place editors (detail screen) — reuse the shared masks/validation ───────────

function TempRangeEditor({ draft, onChange }: { draft: string; onChange: (t: string) => void }) {
  const seed = parseTemp(draft);
  const [min, setMin] = useState(seed.min);
  const [max, setMax] = useState(seed.max);
  const hint = validateTempRange(min, max);
  return (
    <View>
      <View style={styles.affixRow}>
        <TextInput
          value={min}
          onChangeText={(t) => {
            setMin(t);
            onChange(formatTemp(t, max));
          }}
          keyboardType="numbers-and-punctuation"
          placeholder="min"
          placeholderTextColor={colors.onSurfaceVariant}
          style={[typography.bodyLarge, styles.editInput, styles.affixInput]}
          accessibilityLabel="Température minimale"
        />
        <Text style={[typography.bodyLarge, styles.affixDash]}>–</Text>
        <TextInput
          value={max}
          onChangeText={(t) => {
            setMax(t);
            onChange(formatTemp(min, t));
          }}
          keyboardType="numbers-and-punctuation"
          placeholder="max"
          placeholderTextColor={colors.onSurfaceVariant}
          style={[typography.bodyLarge, styles.editInput, styles.affixInput]}
          accessibilityLabel="Température maximale"
        />
        <Text style={[typography.labelLarge, styles.affixUnit]}>°C</Text>
      </View>
      {hint ? <Text style={[typography.labelSmall, styles.editHint]}>{hint}</Text> : null}
    </View>
  );
}

function PriceEditor({ draft, onChange }: { draft: string; onChange: (t: string) => void }) {
  const seed = parsePrice(draft);
  const [amount, setAmount] = useState(seed.amount);
  const currency = seed.currency;
  return (
    <View style={styles.affixRow}>
      <TextInput
        value={amount}
        onChangeText={(t) => {
          const v = t.replace(/[^0-9.,]/g, '');
          setAmount(v);
          onChange(formatPrice(v, currency));
        }}
        keyboardType="decimal-pad"
        placeholder="0.00"
        placeholderTextColor={colors.onSurfaceVariant}
        style={[typography.bodyLarge, styles.editInput, styles.affixInput]}
        accessibilityLabel="Prix"
      />
      <Text style={[typography.labelLarge, styles.affixUnit]}>{currency === 'EUR' ? '€' : currency}</Text>
    </View>
  );
}

function FieldCard({
  field,
  editing,
  draft,
  onChange,
  last,
}: {
  field: ArticleField;
  editing: boolean;
  draft: string;
  onChange: (name: string, text: string) => void;
  last: boolean;
}) {
  const name = field.field_name;
  const display = displayFieldValue(name, field.value);
  const isEmpty = display == null || display.length === 0;
  // FAO: show the exact value, with the human "mer + sous-zone" summary as a quiet subtitle.
  const subtitle = name === 'FAO_area' && field.value ? formatFaoDisplay(field.value) : null;
  const showSubtitle = !!subtitle && subtitle !== field.value;
  const editable = editing;
  const emit = useCallback((t: string) => onChange(name, t), [onChange, name]);

  return (
    <View style={[styles.card, !last && styles.cardDivider]}>
      <View style={styles.cardIcon}>
        <MaterialCommunityIcons name={fieldIcon(name)} size={18} color={colors.primary} />
      </View>
      <View style={styles.cardBody}>
        <Text style={[typography.labelSmall, styles.cardLabel]}>{fieldLabelFr(name)}</Text>
        {editable ? (
          name === 'storage_temperature' ? (
            <TempRangeEditor draft={draft} onChange={emit} />
          ) : name === 'price' ? (
            <PriceEditor draft={draft} onChange={emit} />
          ) : (
            <TextInput
              value={draft}
              onChangeText={emit}
              placeholder="Saisir une valeur"
              placeholderTextColor={colors.onSurfaceVariant}
              style={[typography.bodyLarge, styles.editInput, styles.editInputText]}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              accessibilityLabel={`Champ ${fieldLabelFr(name)}`}
            />
          )
        ) : (
          <>
            <Text
              selectable
              style={[typography.bodyLarge, styles.cardValue, isEmpty && styles.cardEmpty]}
            >
              {isEmpty ? 'Non renseigné' : display}
            </Text>
            {showSubtitle ? (
              <Text style={[typography.bodySmall, styles.cardSubtitle]}>{subtitle}</Text>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

export function ArticleDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<DetailNav>();
  const route = useRoute<DetailRoute>();
  const { articleId } = route.params;
  const { tradeCode } = useAuth();

  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

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

  const articleTradeCode = useMemo(
    () =>
      inferTradeCodeFromFields(
        (article?.fields ?? []).map((field) => field.field_name),
        article?.trade_code ?? tradeCode,
      ),
    [article, tradeCode],
  );
  const articleProfile = businessProfileFor(articleTradeCode);
  const groupedFields = useMemo(
    () => groupFields(article?.fields ?? [], articleProfile.groups),
    [article, articleProfile.groups],
  );
  const fieldCount = useMemo(
    () => groupedFields.reduce((total, group) => total + group.fields.length, 0),
    [groupedFields],
  );

  const handleBack = useCallback(() => navigation.goBack(), [navigation]);

  const enterEdit = useCallback(() => {
    const seed: Record<string, string> = {};
    for (const f of article?.fields ?? []) {
      seed[f.field_name] = f.value ?? '';
    }
    setDrafts(seed);
    setJustSaved(false);
    setEditing(true);
  }, [article]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDrafts({});
  }, []);

  const handleFieldChange = useCallback((name: string, text: string) => {
    setDrafts((d) => ({ ...d, [name]: text }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!article || saving) return;
    setSaving(true);

    const changed: { field_name: string; value: string | null }[] = [];
    for (const f of article.fields) {
      if (!(f.field_name in drafts)) continue;
      const raw = drafts[f.field_name].trim();
      const value = raw === '' ? null : raw;
      if (value === (f.value ?? null)) continue;
      changed.push({ field_name: f.field_name, value });
    }

    if (changed.length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }

    // The API remains authoritative: no confirmed field is written only to the phone.
    const result = await submitFieldOverrides({ ingestionId: article.ingestion_id, fields: changed });
    await queryClient.invalidateQueries({ queryKey: ['catalog', 'arrivals'] });
    if (result.pending === 0) {
      // The projection is asynchronous; reload from the API only when it has caught up.
      const refreshed = await getArticleById(article.id);
      if (refreshed) setArticle(refreshed);
    }

    setEditing(false);
    setSaving(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2600);
  }, [article, drafts, saving]);

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
  const fieldValue = (name: string) =>
    article.fields.find((field) => field.field_name === name)?.value?.trim() ?? '';
  const productName = commonName(article) || 'Produit sans nom';
  const scientificName = fieldValue('scientific_name');
  const producer = fieldValue('producer_name') || fieldValue('reseller_brand');
  const tradeDescription =
    articleProfile.code === 'boucherie'
      ? [fieldValue('cut_name'), fieldValue('animal_species')].filter(Boolean).join(' · ')
      : articleProfile.code === 'charcuterie_traiteur'
        ? [fieldValue('product_family'), fieldValue('manufacturer_name')]
            .filter(Boolean)
            .join(' · ')
        : scientificName;
  const fao = fieldValue('FAO_area');
  const productionMethod = displayFieldValue('production_method', fieldValue('production_method'));

  return (
    <View style={[styles.root, { paddingBottom: editing ? 0 : insets.bottom }]}>
      <View style={styles.photoContainer}>
        {article.photo_uri ? (
          <Pressable
            onPress={() => setViewerOpen(true)}
            style={styles.photoCard}
            accessibilityRole="button"
            accessibilityLabel="Voir la photo en plein écran"
          >
            <Image
              source={{ uri: article.photo_uri, headers: article.photo_headers }}
              resizeMode="cover"
              style={StyleSheet.absoluteFillObject}
            />
          </Pressable>
        ) : (
          <View style={[styles.photoCard, styles.photoPlaceholder]}>
            <MaterialCommunityIcons name="file-document-outline" size={48} color={colors.onSurfaceVariant} />
          </View>
        )}
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          style={[styles.floatingBackButton, { top: insets.top + spacing.sm }]}
          android_ripple={{ color: 'rgba(255,255,255,0.18)', borderless: true }}
          accessibilityRole="button"
          accessibilityLabel="Retour"
        >
          <MaterialCommunityIcons
            name="arrow-left"
            size={23}
            color={colors.onPrimary}
            style={styles.headerIcon}
          />
        </Pressable>
      </View>
      <PhotoViewerModal
        visible={viewerOpen}
        photoUri={article.photo_uri}
        headers={article.photo_headers}
        onClose={() => setViewerOpen(false)}
      />

      <ScrollView
        style={styles.contentCard}
        contentContainerStyle={styles.contentInner}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Product identity first: a stable professional summary before the
            complete traceability record. */}
        <View style={styles.identityCard}>
          <View style={styles.identityHeader}>
            <Text style={[typography.labelSmall, styles.identityEyebrow]}>
              {articleProfile.displayName} · produit enregistré
            </Text>
          </View>

          <Text selectable style={[typography.headlineSmall, styles.productName]}>
            {productName}
          </Text>
          {tradeDescription ? (
            <Text
              selectable
              style={[
                typography.bodyMedium,
                articleProfile.code === 'poissonnerie'
                  ? styles.scientificName
                  : styles.productDescription,
              ]}
            >
              {tradeDescription}
            </Text>
          ) : producer ? (
            <Text selectable style={[typography.bodyMedium, styles.productDescription]}>
              {producer}
            </Text>
          ) : null}

          <View style={styles.summaryChips}>
            <View style={styles.summaryChip}>
              <MaterialCommunityIcons name="identifier" size={14} color={colors.primary} />
              <Text style={[typography.labelMedium, styles.summaryChipText]} numberOfLines={1}>
                Lot {lot?.value && lot.value.length > 0 ? lot.value : 'non renseigné'}
              </Text>
            </View>
            {fao ? (
              <View style={styles.summaryChip}>
                <MaterialCommunityIcons name="map-marker-outline" size={14} color={colors.primary} />
                <Text style={[typography.labelMedium, styles.summaryChipText]} numberOfLines={1}>
                  FAO {fao}
                </Text>
              </View>
            ) : null}
            {productionMethod ? (
              <View style={styles.summaryChip}>
                <MaterialCommunityIcons name="waves" size={14} color={colors.primary} />
                <Text style={[typography.labelMedium, styles.summaryChipText]} numberOfLines={1}>
                  {productionMethod}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.identityFooter}>
            <View style={styles.identityMeta}>
              <MaterialCommunityIcons name="calendar-check-outline" size={15} color={colors.onSurfaceVariant} />
              <Text style={[typography.bodySmall, styles.metaCaption]} numberOfLines={1}>
                {formatDateShort(article.saved_at)}
                {article.saved_by ? `  ·  ${article.saved_by}` : ''}
              </Text>
            </View>
            <Pressable
              onPress={editing ? undefined : enterEdit}
              disabled={editing}
              style={[styles.editButton, editing && styles.editButtonActive]}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel="Modifier la fiche"
              accessibilityState={{ selected: editing, disabled: editing }}
            >
              <MaterialCommunityIcons name="pencil-outline" size={15} color={colors.primary} />
              <Text style={[typography.labelMedium, styles.editButtonText]}>Modifier</Text>
            </Pressable>
          </View>
        </View>

        {justSaved ? (
          <View style={styles.savedBanner}>
            <MaterialCommunityIcons name="check-circle-outline" size={16} color={colors.success} />
            <Text style={[typography.labelSmall, styles.savedText]}>Modifications enregistrées</Text>
          </View>
        ) : null}

        {fieldCount === 0 ? (
          <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
            Aucun champ extrait.
          </Text>
        ) : (
          groupedFields.map((group) => (
            <View key={group.id} style={styles.fieldGroup}>
              <View style={styles.fieldGroupHeader}>
                <MaterialCommunityIcons
                  name={FIELD_GROUP_ICON[group.id] ?? FIELD_GROUP_ICON.other}
                  size={17}
                  color={colors.primary}
                />
                <Text style={[typography.labelLarge, styles.fieldGroupTitle]}>
                  {group.title}
                </Text>
              </View>
              <View style={styles.fieldsCard}>
                {group.fields.map((field, index) => (
                  <FieldCard
                    key={field.field_name}
                    field={field}
                    editing={editing}
                    draft={drafts[field.field_name] ?? ''}
                    onChange={handleFieldChange}
                    last={index === group.fields.length - 1}
                  />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {editing ? (
        <View style={[styles.editBar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <Pressable
            onPress={cancelEdit}
            disabled={saving}
            style={styles.cancelBtn}
            accessibilityRole="button"
            accessibilityLabel="Annuler"
          >
            <Text style={[typography.labelLarge, styles.cancelText]}>Annuler</Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            disabled={saving}
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Enregistrer les modifications"
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <>
                <MaterialCommunityIcons name="check" size={18} color={colors.onPrimary} />
                <Text style={[typography.labelLarge, styles.saveText]}>Enregistrer</Text>
              </>
            )}
          </Pressable>
        </View>
      ) : null}
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
  // A generous, unobstructed product photo. The only overlay is the compact back
  // control; tapping anywhere else still opens the full-screen viewer.
  photoContainer: {
    height: 248,
    position: 'relative',
    backgroundColor: colors.onSurface,
  },
  // Full-bleed cover photo (no inner frame) — fills the header edge-to-edge, same
  // clean treatment as ReviewScreen's hero. A tap opens PhotoViewerModal at full
  // resolution, so the cover crop never loses content.
  photoCard: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingBackButton: {
    position: 'absolute',
    left: spacing.md,
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.48)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  headerIcon: {
    width: 24,
    height: 24,
    lineHeight: 24,
    textAlign: 'center',
    textAlignVertical: 'center',
  },
  contentCard: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    marginTop: -radius.lg,
  },
  contentInner: {
    padding: spacing.lg,
    paddingBottom: spacing['2xl'],
  },
  // ── Product identity summary ───────────────────────────────────────────────
  identityCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.lg,
    ...elevation[1],
  },
  identityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  identityEyebrow: {
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  productName: {
    color: colors.onSurface,
  },
  scientificName: {
    color: colors.onSurfaceVariant,
    fontStyle: 'italic',
    marginTop: 2,
  },
  productDescription: {
    color: colors.onSurfaceVariant,
    marginTop: 2,
  },
  summaryChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  summaryChip: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceContainer,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  summaryChipText: {
    color: colors.onSurfaceVariant,
    flexShrink: 1,
  },
  identityFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  identityMeta: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  metaCaption: {
    color: colors.onSurfaceVariant,
  },
  // Secondary action lives in the summary footer so it never competes with the
  // product title or compresses long names.
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    backgroundColor: colors.surface,
  },
  editButtonText: {
    color: colors.primary,
  },
  editButtonActive: {
    backgroundColor: colors.primaryContainer,
    borderColor: colors.primary,
  },
  savedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.successContainer,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  savedText: {
    color: colors.success,
  },
  // ── Modern field list (one card, dividers between rows) ─────────────────────
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  fieldGroupHeader: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.sm,
  },
  fieldGroupTitle: {
    flex: 1,
    color: colors.onSurface,
  },
  fieldsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    overflow: 'hidden',
    ...elevation[1],
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  cardDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardLabel: {
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  cardValue: {
    color: colors.onSurface,
  },
  cardEmpty: {
    color: colors.outline,
    fontStyle: 'italic',
  },
  cardSubtitle: {
    color: colors.onSurfaceVariant,
    marginTop: 2,
  },
  // ── Edit inputs ─────────────────────────────────────────────────────────────
  editInput: {
    color: colors.onSurface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  editInputText: {
    minHeight: 40,
  },
  affixRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  affixInput: {
    flex: 1,
    minWidth: 0,
  },
  affixDash: {
    color: colors.onSurfaceVariant,
  },
  affixUnit: {
    color: colors.onSurfaceVariant,
  },
  editHint: {
    color: colors.onSurfaceVariant,
    marginTop: spacing.xs,
  },
  // ── Edit action bar ──────────────────────────────────────────────────────────
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  cancelBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  cancelText: {
    color: colors.onSurfaceVariant,
  },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveText: {
    color: colors.onPrimary,
  },
});
