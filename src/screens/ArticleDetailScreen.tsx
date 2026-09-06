/**
 * ArticleDetailScreen — the saved record (the "lot") for one article.
 *
 * Reads in the SAME field order as the registration screen (services/fieldOrder.ts) so the
 * app is consistent end-to-end. Sober identity header (lot + when/who), then a modern card
 * list of every field. Fields are editable IN PLACE (pencil → edit state) — workflow v1:
 * All active profile fields, including GS1-exact ones (lot/DLC/weight/GTIN/packaging); the operator
 * stays in charge. Saving an edit writes the human override to the authoritative
 * backend (source='human', force_gs1 tagged automatically for barcode-derived fields),
 * then refreshes the shared catalogue.
 *
 * Clean UI: no "Édité"/"Modifié" tag, no confidence score, no red. Who/when an
 * edit happened lives only in the header meta, not as per-field badges.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
  Image,
  Alert,
  Animated,
  PanResponder,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { getArticleById } from '../services/storage';
import { Article, ArticleField } from '../types/Article';
import { formatDateShort } from '../services/dates';
import {
  fieldLabelFr,
  displayFieldValue,
  displayFinalFieldValue,
} from '../services/fieldLabels';
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
  isDateField,
  toIsoDate,
} from '../services/inputMasks';
import { submitFieldOverrides } from '../services/fieldOverrideSubmit';
import { queryClient } from '../services/queryClient';
import { PhotoViewerModal } from '../components/PhotoViewerModal';
import { RotatedPhoto } from '../components/RotatedPhoto';
import { ProductionMethodSelector } from '../components/ProductionMethodSelector';
import type { ArticlesStackParamList } from '../navigation/RootNavigator';
import { colors, spacing, radius, typography, elevation } from '../theme';
import { useAuth } from '../context/AuthContext';
import { useAuthenticatedImageSource } from '../hooks/useAuthenticatedImageSource';
import { catalogQueryKey } from '../services/catalogApi';
import { operatorContextKey } from '../services/authStorage';
import { suggestAllergen } from '../services/allergenSuggestions';
import {
  canonicalizeFinalReviewValue,
  validateFinalReviewValues,
} from '../services/finalReviewValidation';
import {
  normalizeFinalReviewValue,
  NOT_COMMUNICATED_VALUE,
} from '../services/fieldCompleteness';

type DetailRoute = RouteProp<ArticlesStackParamList, 'ArticleDetail'>;
type DetailNav = StackNavigationProp<ArticlesStackParamList, 'ArticleDetail'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const DISMISS_DISTANCE = 112;
const DISMISS_VELOCITY = 0.8;
const DRAG_LIMIT = 280;

function canonicalDetailDraft(fieldName: string, draft: string): string {
  const normalized = normalizeFinalReviewValue(draft);
  const canonicalDate =
    normalized !== NOT_COMMUNICATED_VALUE && isDateField(fieldName)
      ? toIsoDate(normalized)
      : normalized;
  return canonicalizeFinalReviewValue(fieldName, canonicalDate);
}

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
  description: 'text-long',
  product_description: 'text-long',
  additives: 'flask-outline',
  preparation_date: 'calendar-edit',
  conditioning_type: 'package-variant-closed',
  storage_mode: 'snowflake',
  use_instructions: 'information-outline',
  reheating_instructions: 'microwave',
};

const LONG_FORM_FIELDS = new Set([
  'description',
  'product_description',
  'ingredients',
  'additives',
  'use_instructions',
  'reheating_instructions',
  'raw_warnings',
]);

const FIELD_GROUP_ICON: Record<string, IconName> = {
  identification: 'food-variant',
  'fishing-origin': 'map-marker-radius-outline',
  'meat-origin': 'map-marker-radius-outline',
  'prepared-composition': 'format-list-bulleted',
  traceability: 'shield-check-outline',
  'dates-conservation': 'clipboard-check-outline',
  commercial: 'scale-balance',
  historical: 'history',
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
  const byName = new Map(fields.filter((field) => field.field_name !== 'price').map((f) => [f.field_name, f]));
  const groups: DisplayFieldGroup[] = [];

  for (const group of fieldGroups) {
    const groupItems: ArticleField[] = [];
    for (const name of group.fields) {
      const field = byName.get(name) ?? {
        field_name: name,
        value: null,
        validation_status: 'missing' as const,
        combined_confidence: 0,
        confidence_band: 'low' as const,
      };
      groupItems.push(field);
      byName.delete(name);
    }
    if (groupItems.length > 0) {
      groups.push({ id: group.id, title: group.title, fields: groupItems });
    }
  }

  const historicalFields = ['product_name', 'supplier_name']
    .map((name) => byName.get(name))
    .filter((field): field is ArticleField => field != null);
  for (const field of historicalFields) byName.delete(field.field_name);
  if (historicalFields.length > 0) {
    groups.push({
      id: 'historical',
      title: 'Informations historiques',
      fields: historicalFields,
    });
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
          keyboardType="numeric"
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
          keyboardType="numeric"
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

function FieldCard({
  field,
  editing,
  draft,
  onChange,
  suggestion,
  last,
}: {
  field: ArticleField;
  editing: boolean;
  draft: string;
  onChange: (name: string, text: string) => void;
  suggestion?: string | null;
  last: boolean;
}) {
  const name = field.field_name;
  const display = displayFinalFieldValue(name, field.value);
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
          name === 'production_method' ? (
            <ProductionMethodSelector value={draft} onChange={emit} />
          ) : name === 'storage_temperature' ? (
            <TempRangeEditor draft={draft} onChange={emit} />
          ) : (
            <>
              <TextInput
                value={draft}
                onChangeText={emit}
                placeholder="Saisir une valeur"
                placeholderTextColor={colors.onSurfaceVariant}
                style={[
                  typography.bodyLarge,
                  styles.editInput,
                  styles.editInputText,
                  LONG_FORM_FIELDS.has(name) && styles.editInputMultiline,
                ]}
                autoCapitalize="words"
                autoCorrect={false}
                multiline={LONG_FORM_FIELDS.has(name)}
                returnKeyType={LONG_FORM_FIELDS.has(name) ? 'default' : 'done'}
                accessibilityLabel={`Champ ${fieldLabelFr(name)}`}
              />
              {name === 'allergens' &&
              (!draft.trim() || draft.trim().toUpperCase() === NOT_COMMUNICATED_VALUE) &&
              suggestion ? (
                <Pressable
                  onPress={() => emit(suggestion)}
                  style={styles.allergenSuggestion}
                  accessibilityRole="button"
                  accessibilityLabel={`Utiliser la suggestion ${suggestion}`}
                >
                  <MaterialCommunityIcons name="lightbulb-outline" size={14} color={colors.primary} />
                  <Text style={[typography.labelSmall, styles.allergenSuggestionText]}>
                    Suggestion : {suggestion}
                  </Text>
                </Pressable>
              ) : null}
            </>
          )
        ) : (
          <>
            <Text
              selectable
              style={[typography.bodyLarge, styles.cardValue, display === 'NC' && styles.cardEmpty]}
            >
              {display}
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

function SummaryFact({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.factItem}>
      <View style={styles.factIcon}>
        <MaterialCommunityIcons name={icon} size={17} color={colors.primary} />
      </View>
      <View style={styles.factText}>
        <Text style={[typography.labelSmall, styles.factLabel]}>{label}</Text>
        <Text selectable style={[typography.labelLarge, styles.factValue]} numberOfLines={2}>
          {value}
        </Text>
      </View>
    </View>
  );
}

export function ArticleDetailScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const navigation = useNavigation<DetailNav>();
  const route = useRoute<DetailRoute>();
  const { articleId } = route.params;
  const { organizationId, actorId, businessPortalId, tradeCode } = useAuth();

  const currentScopeKey = useMemo(
    () =>
      organizationId && actorId && businessPortalId && tradeCode
        ? operatorContextKey({ organizationId, actorId, businessPortalId, tradeCode })
        : null,
    [actorId, businessPortalId, organizationId, tradeCode],
  );
  const latestScopeKey = useRef(currentScopeKey);
  latestScopeKey.current = currentScopeKey;

  const [loadedArticle, setLoadedArticle] = useState<Article | null>(null);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const article = loadedScopeKey === currentScopeKey ? loadedArticle : null;
  const scopeLoading = currentScopeKey != null && loadedScopeKey !== currentScopeKey;
  const photoSource = useAuthenticatedImageSource(article?.photo_uri);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const savedFeedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollOffsetY = useRef(0);
  const dismissTranslateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    setLoadedArticle(null);
    setLoadedScopeKey(null);
    setEditing(false);
    setDrafts({});
    setViewerOpen(false);
    if (!currentScopeKey) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const found = await getArticleById(articleId);
        const belongsToScope =
          found != null &&
          found.business_portal_id === businessPortalId &&
          found.trade_code === tradeCode;
        if (active) {
          setLoadedArticle(belongsToScope ? found : null);
          setLoadedScopeKey(currentScopeKey);
        }
      } catch {
        if (active) {
          setLoadedArticle(null);
          setLoadedScopeKey(currentScopeKey);
          setLoadError(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [articleId, businessPortalId, currentScopeKey, reloadNonce, tradeCode]);

  useEffect(
    () => () => {
      if (savedFeedbackTimeout.current) clearTimeout(savedFeedbackTimeout.current);
    },
    [],
  );

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
  const allergenSuggestion = useMemo(
    () => suggestAllergen(
      (article?.fields ?? []).map((field) => ({
        field_name: field.field_name,
        value: drafts[field.field_name] ?? field.value,
      })),
    ),
    [article, drafts],
  );
  const fieldCount = useMemo(
    () => groupedFields.reduce((total, group) => total + group.fields.length, 0),
    [groupedFields],
  );
  const hasUnsavedChanges = useMemo(() => {
    if (!editing || !article) return false;
    const stored = new Map(article.fields.map((field) => [field.field_name, field.value]));
    return Object.entries(drafts).some(([fieldName, draft]) => {
      const draftValue = canonicalDetailDraft(fieldName, draft);
      return draftValue !== (stored.get(fieldName) ?? null);
    });
  }, [article, drafts, editing]);

  const leaveScreen = useCallback(() => navigation.goBack(), [navigation]);

  const confirmLeaveIfEditing = useCallback(
    (onConfirm: () => void) => {
      if (saving) return;
      if (!hasUnsavedChanges) {
        onConfirm();
        return;
      }

      Alert.alert(
        'Quitter la modification ?',
        'Les changements non enregistrés seront perdus.',
        [
          { text: 'Continuer la saisie', style: 'cancel' },
          { text: 'Quitter', style: 'destructive', onPress: onConfirm },
        ],
      );
    },
    [hasUnsavedChanges, saving],
  );

  const handleBack = useCallback(
    () => confirmLeaveIfEditing(leaveScreen),
    [confirmLeaveIfEditing, leaveScreen],
  );

  const restoreSheetPosition = useCallback(() => {
    Animated.spring(dismissTranslateY, {
      toValue: 0,
      damping: 22,
      stiffness: 240,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [dismissTranslateY]);

  const animateSheetExit = useCallback(() => {
    Animated.timing(dismissTranslateY, {
      toValue: windowHeight + spacing['2xl'],
      duration: 190,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) leaveScreen();
    });
  }, [dismissTranslateY, leaveScreen, windowHeight]);

  const handleSwipeDismiss = useCallback(() => {
    if (hasUnsavedChanges) {
      restoreSheetPosition();
      confirmLeaveIfEditing(animateSheetExit);
      return;
    }
    animateSheetExit();
  }, [animateSheetExit, confirmLeaveIfEditing, hasUnsavedChanges, restoreSheetPosition]);

  const dismissPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gesture) => {
          const isDownward = gesture.dy > 12;
          const isMostlyVertical = Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.25;
          return !saving && scrollOffsetY.current <= 0 && isDownward && isMostlyVertical;
        },
        onPanResponderMove: (_, gesture) => {
          if (gesture.dy <= 0) {
            dismissTranslateY.setValue(0);
            return;
          }
          // A small resistance after the visible drag limit keeps the sheet attached
          // to the finger without letting it disappear before release.
          const resisted =
            gesture.dy <= DRAG_LIMIT
              ? gesture.dy
              : DRAG_LIMIT + (gesture.dy - DRAG_LIMIT) * 0.18;
          dismissTranslateY.setValue(resisted);
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy >= DISMISS_DISTANCE || gesture.vy >= DISMISS_VELOCITY) {
            handleSwipeDismiss();
          } else {
            restoreSheetPosition();
          }
        },
        onPanResponderTerminate: restoreSheetPosition,
      }),
    [dismissTranslateY, handleSwipeDismiss, restoreSheetPosition, saving],
  );

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDrafts({});
    setSaveError(null);
  }, []);

  const handleFieldChange = useCallback((name: string, text: string) => {
    setDrafts((d) => ({ ...d, [name]: text }));
  }, []);

  const handleSave = useCallback(async () => {
    const requestedScopeKey = currentScopeKey;
    if (!article || saving || !requestedScopeKey) return;
    setSaveError(null);

    const stored = new Map(article.fields.map((field) => [field.field_name, field.value]));
    const changed: { field_name: string; value: string | null }[] = [];
    const candidates: Record<string, string | null> = {};
    for (const [fieldName, draft] of Object.entries(drafts)) {
      const value = canonicalDetailDraft(fieldName, draft);
      candidates[fieldName] = value;
      if (value === (stored.get(fieldName) ?? null)) continue;
      changed.push({ field_name: fieldName, value });
    }

    const validationErrors = validateFinalReviewValues(candidates);
    if (validationErrors.length > 0) {
      setSaveError(
        validationErrors
          .slice(0, 3)
          .map((error) => `${fieldLabelFr(error.fieldName)} : ${error.message}`)
          .join('\n'),
      );
      return;
    }

    if (changed.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      // The API remains authoritative: no confirmed field is written only to the phone.
      const result = await submitFieldOverrides({ ingestionId: article.ingestion_id, fields: changed });
      if (latestScopeKey.current !== requestedScopeKey) return;
      if (organizationId && actorId && businessPortalId && tradeCode) {
        await queryClient.invalidateQueries({
          queryKey: catalogQueryKey({ organizationId, actorId, businessPortalId, tradeCode }),
        });
      }
      if (result.pending === 0) {
        // The projection is asynchronous; reload from the API only when it has caught up.
        const refreshed = await getArticleById(article.id);
        if (
          latestScopeKey.current === requestedScopeKey &&
          refreshed?.business_portal_id === businessPortalId &&
          refreshed.trade_code === tradeCode
        ) {
          setLoadedArticle(refreshed);
          setLoadedScopeKey(requestedScopeKey);
        }
      } else {
        setSaveError(
          `${result.pending} modification${result.pending > 1 ? 's' : ''} en attente de synchronisation. Les corrections restent ouvertes jusqu’à confirmation du serveur.`,
        );
        return;
      }

      setEditing(false);
      setDrafts({});
      setJustSaved(true);
      if (savedFeedbackTimeout.current) clearTimeout(savedFeedbackTimeout.current);
      savedFeedbackTimeout.current = setTimeout(() => setJustSaved(false), 2600);
    } catch {
      if (latestScopeKey.current !== requestedScopeKey) return;
      setSaveError('Impossible d’enregistrer pour le moment. Vérifiez votre connexion puis réessayez.');
    } finally {
      if (latestScopeKey.current === requestedScopeKey) setSaving(false);
    }
  }, [actorId, article, businessPortalId, currentScopeKey, drafts, organizationId, saving, tradeCode]);

  if (loading || scopeLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!article) {
    return (
      <View style={[styles.centered, { padding: spacing.lg }]}>
        <MaterialCommunityIcons
          name={loadError ? 'cloud-alert-outline' : 'file-remove-outline'}
          size={40}
          color={colors.onSurfaceVariant}
        />
        <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant, marginTop: spacing.sm }]}>
          {loadError ? 'Impossible de charger cette fiche.' : 'Ce lot est introuvable.'}
        </Text>
        <View style={styles.errorActions}>
          {loadError ? (
            <Pressable
              onPress={() => setReloadNonce((value) => value + 1)}
              style={styles.retryButton}
              accessibilityRole="button"
            >
              <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>Réessayer</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={handleBack} style={styles.backTextButton} accessibilityRole="button">
            <Text style={[typography.labelLarge, { color: colors.primary }]}>Retour</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const lot = article.fields.find((f) => f.field_name === 'batch_number');
  const fieldValue = (name: string) =>
    article.fields.find((field) => field.field_name === name)?.value?.trim() ?? '';
  const productName = commonName(article) || 'NC';
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
  const productionMethodRaw = displayFieldValue(
    'production_method',
    fieldValue('production_method'),
  );
  const productionMethod = displayFinalFieldValue(
    'production_method',
    fieldValue('production_method') || null,
  );
  const origin = fieldValue('origin_country');
  const expiryDate = displayFinalFieldValue('expiry_date', fieldValue('expiry_date') || null);
  const explicitDescription = fieldValue('description') || fieldValue('product_description');
  const descriptionParts = [
    tradeDescription,
    producer,
    productionMethodRaw,
    origin ? `Origine ${origin}` : '',
  ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
  const productDescription = explicitDescription || descriptionParts.join(' · ') || 'NC';
  const summaryFacts = [
    {
      icon: 'identifier' as IconName,
      label: 'N° DE LOT',
      value: displayFinalFieldValue('batch_number', lot?.value ?? null),
    },
    { icon: 'calendar-alert' as IconName, label: 'DATE LIMITE', value: expiryDate },
    {
      icon: 'map-marker-outline' as IconName,
      label: 'ORIGINE',
      value: displayFinalFieldValue('origin_country', origin || null),
    },
    articleProfile.fields.includes('FAO_area')
      ? {
          icon: 'map-outline' as IconName,
          label: 'ZONE FAO',
          value: displayFinalFieldValue('FAO_area', fao || null),
        }
      : null,
  ].filter((fact): fact is { icon: IconName; label: string; value: string } => fact !== null);

  return (
    <Animated.View
      style={[
        styles.root,
        { paddingBottom: editing ? 0 : insets.bottom },
        { transform: [{ translateY: dismissTranslateY }] },
      ]}
      {...dismissPanResponder.panHandlers}
    >
      <PhotoViewerModal
        visible={viewerOpen && photoSource != null}
        photoUri={photoSource?.uri}
        headers={photoSource?.headers}
        halfTurn={article.photo_rotation_degrees === 180}
        baseRotationDegrees={article.photo_base_rotation_degrees ?? -90}
        onClose={() => setViewerOpen(false)}
      />

      <View style={[styles.topBar, { paddingTop: insets.top }]}>
        <View style={styles.dismissHandleSlot} pointerEvents="none">
          <View style={styles.dismissHandle} />
        </View>
        <View style={styles.topBarInner}>
          <Pressable
            onPress={handleBack}
            disabled={saving}
            hitSlop={8}
            style={styles.topBarButton}
            accessibilityRole="button"
            accessibilityLabel="Retour"
            accessibilityState={{ disabled: saving }}
          >
            <MaterialCommunityIcons name="arrow-left" size={22} color={colors.onSurface} />
          </Pressable>

          <View style={styles.topBarTitle}>
            <Text style={[typography.labelSmall, styles.topBarEyebrow]}>CATALOGUE</Text>
            <Text style={[typography.titleMedium, styles.topBarHeading]}>Fiche produit</Text>
          </View>

          {!editing ? (
            <Pressable
              onPress={() => {
                setSaveError(null);
                setEditing(true);
              }}
              disabled={saving || !currentScopeKey}
              hitSlop={8}
              style={[styles.topBarButton, (saving || !currentScopeKey) && styles.saveBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Modifier la fiche"
              accessibilityState={{ disabled: saving || !currentScopeKey }}
            >
              <MaterialCommunityIcons name="pencil-outline" size={20} color={colors.onSurface} />
            </Pressable>
          ) : null}

        </View>
      </View>

      <ScrollView
        style={styles.contentCard}
        contentContainerStyle={[
          styles.contentInner,
          editing && { paddingBottom: spacing['3xl'] + insets.bottom },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(event) => {
          scrollOffsetY.current = event.nativeEvent.contentOffset.y;
        }}
      >
        <View style={styles.contentColumn}>
          {/* A restrained product hero: the image, description and key facts form
              one readable unit before the exhaustive traceability record. */}
          <View style={styles.identityCard}>
            {photoSource ? (
              <Pressable
                onPress={() => setViewerOpen(true)}
                style={styles.photoCard}
                accessibilityRole="button"
                accessibilityLabel="Voir la photo en plein écran"
              >
                <RotatedPhoto
                  source={photoSource}
                  resizeMode="cover"
                  halfTurn={article.photo_rotation_degrees === 180}
                  baseRotationDegrees={article.photo_base_rotation_degrees ?? -90}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.photoHint}>
                  <MaterialCommunityIcons name="arrow-expand" size={14} color={colors.onPrimary} />
                  <Text style={[typography.labelSmall, styles.photoHintText]}>Agrandir</Text>
                </View>
              </Pressable>
            ) : (
              <View style={[styles.photoCard, styles.photoPlaceholder]}>
                <View style={styles.placeholderIcon}>
                  <MaterialCommunityIcons name="image-outline" size={30} color={colors.primary} />
                </View>
                <Text style={[typography.labelMedium, styles.photoPlaceholderText]}>
                  Photo non disponible
                </Text>
              </View>
            )}

            <View style={styles.identityBody}>
              <Text style={[typography.labelSmall, styles.identityEyebrow]}>
                {articleProfile.displayName} · produit enregistré
              </Text>

              <Text selectable style={[typography.headlineSmall, styles.productName]}>
                {productName}
              </Text>

              <View style={styles.descriptionBlock}>
                <Text style={[typography.labelSmall, styles.descriptionLabel]}>DESCRIPTION</Text>
                <Text
                  selectable
                  style={[typography.bodyMedium, styles.productDescription]}
                >
                  {productDescription}
                </Text>
              </View>

              {articleProfile.fields.includes('production_method') ? (
                <View style={styles.summaryChip}>
                  <MaterialCommunityIcons name="sprout-outline" size={14} color={colors.primary} />
                  <Text style={[typography.labelMedium, styles.summaryChipText]}>
                    {productionMethod}
                  </Text>
                </View>
              ) : null}

              <View style={styles.factsGrid}>
                {summaryFacts.map((fact) => (
                  <SummaryFact key={fact.label} {...fact} />
                ))}
              </View>

              <View style={styles.identityMeta}>
                <MaterialCommunityIcons
                  name="calendar-check-outline"
                  size={15}
                  color={colors.onSurfaceVariant}
                />
                <Text style={[typography.bodySmall, styles.metaCaption]}>
                  Enregistré le {formatDateShort(article.saved_at)}
                  {article.saved_by ? ` · ${article.saved_by}` : ''}
                </Text>
              </View>
            </View>
          </View>

          {justSaved ? (
            <View style={styles.savedBanner} accessibilityLiveRegion="polite">
              <MaterialCommunityIcons name="check-circle-outline" size={17} color={colors.success} />
              <Text style={[typography.labelLarge, styles.savedText]}>Modifications enregistrées</Text>
            </View>
          ) : null}

          {saveError ? (
            <View style={styles.errorBanner} accessibilityLiveRegion="assertive">
              <MaterialCommunityIcons name="alert-circle-outline" size={18} color={colors.error} />
              <Text style={[typography.bodySmall, styles.errorText]}>{saveError}</Text>
            </View>
          ) : null}

          <View style={styles.recordHeader}>
            <View style={styles.recordHeaderText}>
              <Text style={[typography.titleLarge, styles.recordTitle]}>Informations produit</Text>
              <Text style={[typography.bodySmall, styles.recordSubtitle]}>
                {fieldCount} information{fieldCount > 1 ? 's' : ''} affichée{fieldCount > 1 ? 's' : ''} · fiche modifiable
              </Text>
            </View>
            {editing ? (
              <View style={styles.editingBadge}>
                <View style={styles.editingDot} />
                <Text style={[typography.labelSmall, styles.editingBadgeText]}>MODE ÉDITION</Text>
              </View>
            ) : null}
          </View>

          {fieldCount === 0 ? (
            <View style={styles.emptyRecord}>
              <MaterialCommunityIcons name="text-box-remove-outline" size={26} color={colors.outline} />
              <Text style={[typography.bodyMedium, styles.emptyRecordText]}>
                Aucun champ extrait.
              </Text>
            </View>
          ) : (
            groupedFields.map((group) => (
              <View key={group.id} style={styles.fieldGroup}>
                <View style={styles.fieldGroupHeader}>
                  <View style={styles.fieldGroupIcon}>
                    <MaterialCommunityIcons
                      name={FIELD_GROUP_ICON[group.id] ?? FIELD_GROUP_ICON.other}
                      size={17}
                      color={colors.primary}
                    />
                  </View>
                  <Text style={[typography.titleMedium, styles.fieldGroupTitle]}>
                    {group.title}
                  </Text>
                </View>
                <View style={styles.fieldsCard}>
                  {group.fields.map((field, index) => (
                    <FieldCard
                      key={field.field_name}
                      field={field}
                      editing={editing}
                      draft={
                        drafts[field.field_name] ??
                        displayFinalFieldValue(field.field_name, field.value)
                      }
                      onChange={handleFieldChange}
                      suggestion={field.field_name === 'allergens' ? allergenSuggestion : undefined}
                      last={index === group.fields.length - 1}
                    />
                  ))}
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {editing ? (
        <View style={[styles.editBar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <View style={styles.editBarInner}>
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
        </View>
      ) : null}
    </Animated.View>
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
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorActions: {
    marginTop: spacing.md,
    alignItems: 'center',
    gap: spacing.xs,
  },
  retryButton: {
    minHeight: 44,
    minWidth: 132,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  topBar: {
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.outlineVariant,
    zIndex: 2,
  },
  dismissHandleSlot: {
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissHandle: {
    width: 38,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.outlineVariant,
  },
  topBarInner: {
    width: '100%',
    maxWidth: 720,
    minHeight: 64,
    paddingHorizontal: spacing.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  topBarButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceContainer,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  topBarTitle: {
    flex: 1,
    minWidth: 0,
  },
  topBarEyebrow: {
    color: colors.primary,
    letterSpacing: 0.9,
  },
  topBarHeading: {
    color: colors.onSurface,
  },
  contentCard: {
    flex: 1,
    backgroundColor: colors.background,
  },
  contentInner: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing['2xl'],
  },
  contentColumn: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  // ── Product identity summary ───────────────────────────────────────────────
  identityCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    ...elevation[1],
  },
  photoCard: {
    width: '100%',
    height: 212,
    position: 'relative',
    backgroundColor: colors.surfaceContainer,
    overflow: 'hidden',
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  placeholderIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPlaceholderText: {
    color: colors.onSurfaceVariant,
  },
  photoHint: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(21,38,34,0.78)',
  },
  photoHintText: {
    color: colors.onPrimary,
  },
  identityBody: {
    alignItems: 'center',
    padding: spacing.lg,
  },
  identityEyebrow: {
    color: colors.primary,
    textTransform: 'uppercase',
    textAlign: 'center',
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  },
  productName: {
    color: colors.onSurface,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  descriptionBlock: {
    width: '100%',
    maxWidth: 560,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  descriptionLabel: {
    color: colors.outline,
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  },
  productDescription: {
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    lineHeight: 22,
  },
  summaryChip: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
    borderWidth: 1,
    borderColor: colors.primaryContainer,
    marginBottom: spacing.lg,
  },
  summaryChipText: {
    color: colors.onPrimaryContainer,
    flexShrink: 1,
  },
  factsGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  factItem: {
    minWidth: 144,
    flexGrow: 1,
    flexBasis: 0,
    maxWidth: 220,
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceContainer,
  },
  factIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  factText: {
    flex: 1,
    minWidth: 0,
  },
  factLabel: {
    color: colors.onSurfaceVariant,
    letterSpacing: 0.7,
  },
  factValue: {
    color: colors.onSurface,
  },
  identityMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    width: '100%',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  metaCaption: {
    color: colors.onSurfaceVariant,
    flexShrink: 1,
    textAlign: 'center',
  },
  savedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.successContainer,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#CDEAD7',
  },
  savedText: {
    color: colors.success,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.errorContainer,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  errorText: {
    color: colors.onErrorContainer,
    flex: 1,
  },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  recordHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  recordTitle: {
    color: colors.onSurface,
  },
  recordSubtitle: {
    color: colors.onSurfaceVariant,
    marginTop: 2,
  },
  editingBadge: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
  },
  editingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  editingBadgeText: {
    color: colors.onPrimaryContainer,
  },
  emptyRecord: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 132,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  emptyRecordText: {
    color: colors.onSurfaceVariant,
  },
  // ── Complete field list ─────────────────────────────────────────────────────
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  fieldGroupHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.sm,
  },
  fieldGroupIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryContainer,
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
    gap: spacing.sm,
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
    borderRadius: radius.sm,
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
  editInputMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  allergenSuggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
  },
  allergenSuggestionText: {
    color: colors.onPrimaryContainer,
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
    paddingTop: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
    ...elevation[3],
  },
  editBarInner: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cancelBtn: {
    minHeight: 48,
    minWidth: 104,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
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
    minHeight: 48,
    paddingHorizontal: spacing.lg,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveText: {
    color: colors.onPrimary,
  },
});
