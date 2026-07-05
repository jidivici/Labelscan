/**
 * ArticleDetailScreen — the saved record (the "lot") for one article.
 *
 * Reads in the SAME field order as the registration screen (services/fieldOrder.ts) so the
 * app is consistent end-to-end. Sober identity header (lot + when/who), then a modern card
 * list of every field. Fields are editable IN PLACE (pencil → edit state) — workflow v1:
 * ALL 17 fields, including GS1-exact ones (lot/DLC/weight/GTIN/packaging); the operator
 * stays in charge. Saving an edit RE-RECORDS the article with the current user
 * (saved_by/saved_at) and pushes the human override to the authoritative backend,
 * best-effort (submitFieldOverrides, source='human', force_gs1 tagged automatically for
 * barcode-derived fields).
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

import { getArticleById, updateBackendArticle } from '../services/storage';
import { Article, ArticleField } from '../types/Article';
import { formatDateShort } from '../services/dates';
import { fieldLabelFr, displayFieldValue } from '../services/fieldLabels';
import { formatFaoDisplay } from '../services/faoDisplay';
import { FIELD_ORDER } from '../services/fieldOrder';
import {
  parseTemp,
  formatTemp,
  validateTempRange,
  parsePrice,
  formatPrice,
} from '../services/inputMasks';
import { submitFieldOverrides } from '../services/fieldOverrideSubmit';
import { PhotoViewerModal } from '../components/PhotoViewerModal';
import { useAuth } from '../context/AuthContext';
import type { ArticlesStackParamList } from '../navigation/RootNavigator';
import { colors, spacing, radius, typography, elevation } from '../theme';

type DetailRoute = RouteProp<ArticlesStackParamList, 'ArticleDetail'>;
type DetailNav = StackNavigationProp<ArticlesStackParamList, 'ArticleDetail'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// A quiet leading icon per field — gives each row a modern, anchored look (and fills the
// otherwise-bare list). Purely decorative; unknown fields fall back to a generic tag.
const FIELD_ICON: Record<string, IconName> = {
  commercial_designation: 'fish',
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
};

function fieldIcon(name: string): IconName {
  return FIELD_ICON[name] ?? 'tag-outline';
}

/** Order the saved fields by the shared FIELD_ORDER; any extra field is appended after. */
function orderFields(fields: ArticleField[]): ArticleField[] {
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const ordered: ArticleField[] = [];
  for (const name of FIELD_ORDER) {
    const f = byName.get(name);
    if (f) {
      ordered.push(f);
      byName.delete(name);
    }
  }
  for (const f of byName.values()) ordered.push(f);
  return ordered;
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
        <MaterialCommunityIcons name={fieldIcon(name)} size={18} color={colors.onSurfaceVariant} />
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
  const { user } = useAuth();

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

  const orderedFields = useMemo(() => orderFields(article?.fields ?? []), [article]);

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
    const nextFields = article.fields.map((f) => {
      if (!(f.field_name in drafts)) return f;
      const raw = drafts[f.field_name].trim();
      const value = raw === '' ? null : raw;
      if (value === (f.value ?? null)) return f; // unchanged
      changed.push({ field_name: f.field_name, value });
      return { ...f, value, edited: true };
    });

    if (changed.length === 0) {
      setEditing(false);
      setSaving(false);
      return;
    }

    // Re-record locally (new saved_at + saved_by = the editor), then push the override.
    const updated = await updateBackendArticle(article.id, { fields: nextFields, saved_by: user });
    if (updated) setArticle(updated);
    void submitFieldOverrides({ ingestionId: article.ingestion_id, fields: changed });

    setEditing(false);
    setSaving(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2600);
  }, [article, drafts, saving, user]);

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
            <Image source={{ uri: article.photo_uri }} resizeMode="cover" style={StyleSheet.absoluteFillObject} />
            <View style={styles.expandHint}>
              <MaterialCommunityIcons name="arrow-expand" size={16} color={colors.onPrimary} />
            </View>
          </Pressable>
        ) : (
          <View style={[styles.photoCard, styles.photoPlaceholder]}>
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
      <PhotoViewerModal
        visible={viewerOpen}
        photoUri={article.photo_uri}
        onClose={() => setViewerOpen(false)}
      />

      <ScrollView
        style={styles.contentCard}
        contentContainerStyle={styles.contentInner}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Sober identity header: the lot, when/who, and the edit toggle. */}
        <View style={styles.identityCard}>
          <View style={styles.identityMain}>
            <Text style={[typography.labelSmall, styles.overline]}>Numéro de lot</Text>
            <Text selectable style={[typography.titleLarge, styles.lotValue]}>
              {lot?.value && lot.value.length > 0 ? lot.value : '—'}
            </Text>
            <Text style={[typography.bodySmall, styles.metaCaption]}>
              {formatDateShort(article.saved_at)}
              {user ? `  ·  ${user}` : ''}
            </Text>
          </View>
          {!editing ? (
            <Pressable
              onPress={enterEdit}
              style={styles.editButton}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel="Modifier la fiche"
            >
              <MaterialCommunityIcons name="pencil-outline" size={15} color={colors.primary} />
              <Text style={[typography.labelMedium, styles.editButtonText]}>Modifier</Text>
            </Pressable>
          ) : null}
        </View>

        {justSaved ? (
          <View style={styles.savedBanner}>
            <MaterialCommunityIcons name="check-circle-outline" size={16} color={colors.success} />
            <Text style={[typography.labelSmall, styles.savedText]}>Modifications enregistrées</Text>
          </View>
        ) : null}

        <Text style={[typography.labelSmall, styles.overline, styles.sectionLabel]}>
          {editing ? 'Modifier les champs' : `Champs (${orderedFields.length})`}
        </Text>

        {orderedFields.length === 0 ? (
          <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
            Aucun champ extrait.
          </Text>
        ) : (
          <View style={styles.fieldsCard}>
            {orderedFields.map((f, i) => (
              <FieldCard
                key={f.field_name}
                field={f}
                editing={editing}
                draft={drafts[f.field_name] ?? ''}
                onChange={handleFieldChange}
                last={i === orderedFields.length - 1}
              />
            ))}
          </View>
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
  // Same hero height as ReviewScreen (PHOTO_HEIGHT_LANDSCAPE) so every large photo
  // in the app is framed identically.
  photoContainer: {
    height: 200,
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
  expandHint: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
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
  },
  contentInner: {
    padding: spacing.lg,
    paddingBottom: spacing['2xl'],
  },
  // ── Sober identity header ──────────────────────────────────────────────────
  identityCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  identityMain: {
    flexShrink: 1,
  },
  lotValue: {
    color: colors.onSurface,
    marginTop: 2,
  },
  metaCaption: {
    color: colors.onSurfaceVariant,
    marginTop: spacing.xs,
  },
  // Clear "touch to edit" affordance — a labeled pill, not a bare icon.
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryContainer,
  },
  editButtonText: {
    color: colors.primary,
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
  overline: {
    color: colors.onSurfaceVariant,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  sectionLabel: {
    marginBottom: spacing.sm,
  },
  // ── Modern field list (one card, dividers between rows) ─────────────────────
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
    backgroundColor: colors.surfaceContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardLabel: {
    color: colors.onSurfaceVariant,
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
