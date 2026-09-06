/**
 * ReviewScreen — the single review/edit path (workflow v1).
 *
 * Opened from the home screen's "En cours" section for one queued scan (by
 * `pendingScanId`); reads its photo/barcode/extraction result LIVE from the scan
 * queue (useScan) rather than from navigation params, so it always reflects the
 * queue's current truth. Displays the server extraction result (status + per-field
 * value/confidence/validation_status) and finalises the review on the backend before
 * removing the scan from the local queue.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  TextInput,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import {
  deleteConfirmedPhoto,
  deletePendingPhoto,
  getAllArticles,
  persistConfirmedPhoto,
} from '../services/storage';
import { queryClient } from '../services/queryClient';
import { businessProfileFor } from '../services/businessProfiles';
import { catalogQueryKey } from '../services/catalogApi';
import { suggestAllergen } from '../services/allergenSuggestions';
import { ProductionMethodSelector } from '../components/ProductionMethodSelector';
import { buildFieldHistory, suggestForField, type FieldHistory } from '../services/fieldHistory';
import {
  enqueueFinalizeReview,
  getOperation,
  requeueDeadLetter,
  updatePendingFinalizeReview,
} from '../services/outbox';
import { drainOutbox } from '../services/outboxDrain';
import {
  maskDate,
  isDateField,
  displayDate,
  toIsoDate,
  parseWeight,
  formatWeight,
  parseTemp,
  formatTemp,
  validateDate,
  validateTempRange,
  validateWeight,
  isHealthMarkField,
  maskHealthMark,
  validateHealthMark,
  type WeightUnit,
} from '../services/inputMasks';
import { displayFieldValue, fieldLabelFr, ingestionStatusFr } from '../services/fieldLabels';
import { parseGs1, gs1FieldValues } from '../services/gs1';
import { useScan } from '../hooks/useScanQueue';
import {
  attachFinalizeOperation,
  completeScan,
  discardScan,
  saveScanEdits,
  saveScanPhotoRotation,
} from '../services/scanQueue';
import {
  filledCountFromRun,
  initialHumanReviewValue,
  normalizeFinalReviewValue,
  NOT_COMMUNICATED_VALUE,
  notCommunicatedSuggestion,
} from '../services/fieldCompleteness';
import {
  RECAPTURE_GUIDANCE,
  RECAPTURE_MESSAGE,
  RECAPTURE_TITLE,
} from '../services/extractionUsability';
import { SkeletonValue } from '../components/SkeletonFieldList';
import { PhotoViewerModal } from '../components/PhotoViewerModal';
import { RotatedPhoto } from '../components/RotatedPhoto';
import { ExtractionProgress } from '../components/ExtractionProgress';
import { formatDate } from '../services/dates';
import { logLatency } from '../services/latencyLog';
import {
  allowsNotCommunicated,
  canonicalizeFinalReviewValue,
  validateFinalReviewValues,
} from '../services/finalReviewValidation';
import {
  captureActiveSession,
  isSessionFenceCurrent,
  operatorContextKey,
} from '../services/authStorage';
import {
  requiresExplicitHumanConfirmation,
  shouldHighlightReviewField,
} from '../services/reviewFieldAttention';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, radius, typography, elevation } from '../theme';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { ExtractionField } from '../types/api';
import type { Article, ArticleField } from '../types/Article';

type RouteType = RouteProp<RootStackParamList, 'Review'>;
type NavProp = StackNavigationProp<RootStackParamList, 'Review'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const FIELD_GROUP_ICON: Record<string, IconName> = {
  identification: 'food-variant',
  'fishing-origin': 'map-marker-radius-outline',
  'meat-origin': 'map-marker-radius-outline',
  'prepared-composition': 'format-list-bulleted',
  traceability: 'shield-check-outline',
  'dates-conservation': 'clipboard-check-outline',
  commercial: 'scale-balance',
};

// Landscape photo height at the top of the review — wide and low so the whole label
// reads landscape, leaving maximum room for the field list below (coherence request).
const PHOTO_HEIGHT_LANDSCAPE = 200;

// ── Server extraction — single homogeneous editable list ──────────────────────────

// Empty fields get a brand-tinted review cue, computed from the live draft inside
// EditableFieldRow (so it clears the instant a value is typed or explicitly marked NC).
// Raw AI confidence stays hidden: the operator receives one actionable human-review
// state instead of provider-specific implementation details.

// Canonical profile display order. The SAME order drives the loading skeleton
// list AND the ready list, so rows never reshuffle when the run lands (audit §2.2 — zero
// layout shift). Readable HACCP order: identity → method/origin → lot/dates → conservation.
// FIELD_ORDER now lives in services/fieldOrder.ts — SHARED with ArticleDetailScreen so the
// app reads fields in ONE consistent order (registration ⇄ detail).

/**
 * One placeholder row in the stable list while the LLM run is still loading: the real
 * field LABEL is shown, and the VALUE is the GS1-decoded value (T+0), the Tier 3 wave-2
 * deterministic preview (~OCR done), or a pulsing skeleton. Same geometry as
 * EditableFieldRow → swapping it in at ready does not move anything (audit §2.1/2.2).
 * Values swap in plainly (no cascade animation — the review stays dead simple).
 */
function PendingFieldRow({
  fieldName,
  gs1Value,
}: {
  fieldName: string;
  gs1Value?: string;
}) {
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldHeader}>
        <Text style={[typography.labelSmall, styles.fieldName]}>{fieldLabelFr(fieldName)}</Text>
      </View>
      {gs1Value != null ? (
        <View style={styles.input}>
          <Text style={[typography.bodyMedium, { color: colors.onSurface }]}>{gs1Value}</Text>
        </View>
      ) : (
        <SkeletonValue />
      )}
    </View>
  );
}

/**
 * Weight field: numeric input with an integrated, tappable unit affix (kg ⇄ g). Local
 * state is seeded once from the draft so typing decimals/units is not mangled by a
 * round-trip through the reconstructed string. Emits "amount unit" (e.g. "5 kg").
 */
function WeightInput({
  draft,
  onChange,
  highlighted,
  onFocus,
  onBlur,
}: {
  draft: string;
  onChange: (text: string) => void;
  highlighted: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const seed = parseWeight(draft);
  const [amount, setAmount] = useState(seed.amount);
  const [unit, setUnit] = useState<WeightUnit>(seed.unit);

  return (
    <View style={styles.affixRow}>
      <TextInput
        value={amount}
        onChangeText={(t) => {
          if (notCommunicatedSuggestion(t)) {
            setAmount(t);
            onChange(t);
            return;
          }
          const v = t.replace(/[^0-9.,]/g, '');
          setAmount(v);
          onChange(formatWeight(v, unit));
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        keyboardType="default"
        placeholder="0"
        placeholderTextColor={colors.onSurfaceVariant}
        style={[typography.bodyMedium, styles.affixInput, highlighted ? styles.affixInputHighlighted : null]}
        accessibilityLabel="Poids"
      />
      <Pressable
        onPress={() => {
          const next: WeightUnit = unit === 'kg' ? 'g' : 'kg';
          setUnit(next);
          onChange(formatWeight(amount, next));
        }}
        style={styles.affixUnitToggle}
        accessibilityRole="button"
        accessibilityLabel={`Unité : ${unit}. Toucher pour changer.`}
      >
        <Text style={[typography.labelLarge, styles.affixUnitText]}>{unit}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Storage-temperature field: two numeric inputs [min] – [max] with a "°C" affix.
 * Local state seeded once from the draft. Emits "min - max °C" (or a single bound).
 */
function TempRangeInput({
  draft,
  onChange,
  highlighted,
  onFocus,
  onBlur,
}: {
  draft: string;
  onChange: (text: string) => void;
  highlighted: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const seed = parseTemp(draft);
  const [min, setMin] = useState(seed.min);
  const [max, setMax] = useState(seed.max);

  return (
    <View style={styles.affixRow}>
      <TextInput
        value={min}
        onChangeText={(t) => {
          setMin(t);
          onChange(formatTemp(t, max));
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        keyboardType="numeric"
        placeholder="min"
        placeholderTextColor={colors.onSurfaceVariant}
        style={[typography.bodyMedium, styles.affixInput, highlighted ? styles.affixInputHighlighted : null]}
        accessibilityLabel="Température minimale"
      />
      <Text style={[typography.bodyLarge, styles.affixDash]}>–</Text>
      <TextInput
        value={max}
        onChangeText={(t) => {
          setMax(t);
          onChange(formatTemp(min, t));
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        keyboardType="numeric"
        placeholder="max"
        placeholderTextColor={colors.onSurfaceVariant}
        style={[typography.bodyMedium, styles.affixInput, highlighted ? styles.affixInputHighlighted : null]}
        accessibilityLabel="Température maximale"
      />
      <Text style={[typography.labelLarge, styles.affixUnitText]}>°C</Text>
    </View>
  );
}

const EditableFieldRow = React.memo(function EditableFieldRow({
  field,
  draft,
  onChange,
  suggestion,
  history,
  edited,
}: {
  field: ExtractionField;
  draft: string;
  // (name, text) so the parent keeps ONE stable callback for all rows — combined with
  // React.memo, a keystroke then re-renders ONLY the edited row (audit §7.1).
  onChange: (name: string, text: string) => void;
  suggestion?: string | null;
  /** Per-field autocomplete history (workflow v2.1) — STABLE reference, built once. */
  history?: FieldHistory | null;
  edited: boolean;
}) {
  // The review cue is REACTIVE to the live draft (not the server value): an empty
  // machine result remains unconfirmed until the operator enters a value or selects NC.
  const empty = draft.trim() === '';
  // A questionable extraction is deliberately styled like an empty field: same calm
  // green cue, never an alarming error colour. We do not expose raw provider text;
  // the usual field suggestions remain the only assistance under the input.
  const highlighted = shouldHighlightReviewField(
    draft,
    field.validation_status,
    edited,
    field.source,
  );
  const needsExplicitConfirmation =
    !empty &&
    !edited &&
    requiresExplicitHumanConfirmation(field.validation_status, field.source);
  // A suggestion is offered only while the field is still empty; it never overrides a
  // typed/extracted value and is applied only on tap (→ a human edit on save).
  const showSuggestion = !!suggestion && empty;
  // Bind this row's field name once; the affix inputs and the suggestion chip emit through it.
  const emit = (text: string) => onChange(field.field_name, text);
  // Date fields: number-pad + a DD/MM/YYYY mask (auto "/"). An INPUT helper that
  // formats the digits the operator reads off the label — it never computes a date.
  const isDate = isDateField(field.field_name);
  const allowsNC = allowsNotCommunicated(field.field_name);
  const isNotCommunicated = draft.trim().toUpperCase() === NOT_COMMUNICATED_VALUE;
  // Health mark ("estampille sanitaire"): the official stamp is always uppercase, so
  // every keystroke is force-cased — never a stripped/computed character.
  const isHealthMark = isHealthMarkField(field.field_name);
  const attentionLabel =
    !edited && requiresExplicitHumanConfirmation(field.validation_status, field.source)
      ? 'À vérifier'
      : 'À compléter';
  const handleChange = (text: string) => {
    if (allowsNC && notCommunicatedSuggestion(text)) {
      emit(text);
      return;
    }
    emit(isDate ? maskDate(text) : isHealthMark ? maskHealthMark(text) : text);
  };
  // History autocomplete (workflow v2.1): chips shown ONLY while this row's input is
  // focused, so the 16 other rows never render suggestion clutter. suggestForField
  // returns [] for non-history fields (dates, lot, gtin, affix inputs) — no per-field
  // wiring needed here. Applying a chip goes through emit → a HUMAN edit, exactly like
  // typing it (no-fabrication gate untouched).
  const [focused, setFocused] = useState(false);
  const historySuggestions = useMemo(() => {
    if (!focused) return [];
    const nc = allowsNC ? notCommunicatedSuggestion(draft) : null;
    const saved = history ? suggestForField(history, field.field_name, draft) : [];
    return [
      ...(nc ? [nc] : []),
      ...saved.filter((value) => value !== nc && (allowsNC || value !== NOT_COMMUNICATED_VALUE)),
    ].slice(0, 3);
  }, [allowsNC, focused, history, field.field_name, draft]);

  // Real-time, NEUTRAL, non-blocking validity hint (Clean UI: no red, never blocks the
  // save). Computed from the live draft so it updates as the operator types; null while
  // the value is empty, valid, or still being typed.
  let hint: string | null = null;
  if (isDate) hint = validateDate(draft);
  else if (field.field_name === 'weight') hint = validateWeight(parseWeight(draft).amount);
  else if (field.field_name === 'storage_temperature') {
    const t = parseTemp(draft);
    hint = validateTempRange(t.min, t.max);
  } else if (isHealthMark) hint = validateHealthMark(draft);
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldHeader}>
        <Text style={[typography.labelSmall, styles.fieldName]}>{fieldLabelFr(field.field_name)}</Text>
        {empty || needsExplicitConfirmation ? (
          <Text style={[typography.labelSmall, styles.attentionTag]}>{attentionLabel}</Text>
        ) : null}
      </View>
      {isNotCommunicated && allowsNC && ['weight', 'storage_temperature'].includes(field.field_name) ? (
        <TextInput
          value={draft}
          onChangeText={emit}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          selectTextOnFocus
          style={[typography.bodyMedium, styles.input]}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel={`Champ ${fieldLabelFr(field.field_name)}`}
        />
      ) : field.field_name === 'weight' ? (
        <WeightInput
          draft={draft}
          onChange={emit}
          highlighted={highlighted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      ) : field.field_name === 'storage_temperature' ? (
        <TempRangeInput
          draft={draft}
          onChange={emit}
          highlighted={highlighted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      ) : field.field_name === 'production_method' ? (
        <ProductionMethodSelector value={draft} onChange={emit} />
      ) : (
        <TextInput
          value={draft}
          onChangeText={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType={isDate ? 'number-pad' : 'default'}
          maxLength={isDate ? 10 : undefined}
          placeholder={isDate ? 'JJ/MM/AAAA' : empty ? 'Saisir la valeur' : 'Valeur extraite'}
          placeholderTextColor={colors.onSurfaceVariant}
          style={[
            typography.bodyMedium,
            styles.input,
            highlighted ? styles.inputHighlighted : null,
          ]}
          autoCapitalize={isHealthMark ? 'characters' : 'words'}
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel={`Champ ${fieldLabelFr(field.field_name)}`}
        />
      )}
      {hint ? <Text style={[typography.labelSmall, styles.inputHint]}>{hint}</Text> : null}
      {needsExplicitConfirmation ? (
        <View style={styles.reviewDecisionRow}>
          <Pressable
            onPress={() => emit(draft)}
            style={styles.confirmSuggestionChip}
            android_ripple={{ color: colors.primaryContainer }}
            accessibilityRole="button"
            accessibilityLabel={`Confirmer la valeur proposée pour ${fieldLabelFr(field.field_name)}`}
          >
            <MaterialCommunityIcons name="check" size={14} color={colors.onPrimary} />
            <Text style={[typography.labelSmall, styles.confirmSuggestionChipText]}>
              Confirmer cette valeur
            </Text>
          </Pressable>
          {allowsNC ? (
            <Pressable
              onPress={() => emit(NOT_COMMUNICATED_VALUE)}
              style={styles.notCommunicatedChip}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel={`Marquer ${fieldLabelFr(field.field_name)} non communiqué`}
              accessibilityHint="Remplace la valeur proposée par NC"
            >
              <Text style={[typography.labelSmall, styles.notCommunicatedChipText]}>Marquer NC</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {empty && allowsNC ? (
        <Pressable
          onPress={() => emit(NOT_COMMUNICATED_VALUE)}
          style={styles.notCommunicatedChip}
          android_ripple={{ color: colors.primaryContainer }}
          accessibilityRole="button"
          accessibilityLabel={`Marquer ${fieldLabelFr(field.field_name)} non communiqué`}
          accessibilityHint="Confirme que cette information est absente de l’étiquette"
        >
          <MaterialCommunityIcons name="eye-check-outline" size={14} color={colors.primary} />
          <Text style={[typography.labelSmall, styles.notCommunicatedChipText]}>
            Information absente · Marquer NC
          </Text>
        </Pressable>
      ) : null}
      {historySuggestions.length > 0 ? (
        <View style={styles.historyChipsRow}>
          {historySuggestions.map((value) => (
            <Pressable
              key={value}
              onPress={() => emit(value)}
              style={styles.historyChip}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel={`Utiliser ${value}`}
            >
              <MaterialCommunityIcons name="history" size={13} color={colors.onSurfaceVariant} />
              <Text style={[typography.labelSmall, styles.historyChipText]} numberOfLines={1}>
                {value}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {showSuggestion ? (
        <Pressable
          onPress={() => emit(suggestion as string)}
          style={styles.suggestionChip}
          android_ripple={{ color: colors.primaryContainer }}
          accessibilityRole="button"
          accessibilityLabel={`Utiliser la suggestion ${suggestion}`}
        >
          <MaterialCommunityIcons name="lightbulb-outline" size={13} color={colors.primary} />
          <Text style={[typography.labelSmall, styles.suggestionChipText]}>
            Suggestion : {suggestion}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

export function ReviewScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteType>();
  const { user, organizationId, actorId, businessPortalId, tradeCode } = useAuth();
  const { pendingScanId } = route.params;

  // Single source of truth (workflow v1): photo, barcode, ingestion id and the
  // extraction result are read LIVE from the scan queue, never carried through
  // navigation — this screen always reflects the queue's current truth, whether it
  // mounted while the scan was still extracting or already ready.
  const { scan, result, interimValues } = useScan(pendingScanId);
  const ocrDone = scan?.ocrDone === true;
  const ready = scan?.status === 'ready';
  const queueRequiresRecapture = scan?.status === 'recapture_required';
  const ingestion = result?.ingestion ?? null;
  const run = result?.run ?? null;
  const ingestionId = scan?.ingestionId ?? null;
  const photoUri = scan?.photoUri;
  const barcodeRaw = scan?.barcodeRaw;
  const reviewProfile = businessProfileFor(scan?.tradeCode ?? tradeCode);
  const fieldGroups = reviewProfile.groups;
  const fieldOrder = reviewProfile.fields;
  const currentScopeKey = useMemo(
    () =>
      organizationId && actorId && businessPortalId && tradeCode
        ? operatorContextKey({ organizationId, actorId, businessPortalId, tradeCode })
        : null,
    [actorId, businessPortalId, organizationId, tradeCode],
  );

  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [photoRotationDegrees, setPhotoRotationDegrees] = useState<0 | 180>(scan?.photoRotationDegrees ?? 0);
  // Workflow v2 "session": seed the draft from the scan's persisted edits so a
  // partially-filled arrivage is restored on re-open (the scan stays "en cours" until
  // all profile fields are filled and validated). Lazy init — the queue is already hydrated
  // by the time this screen is reached (it also redirects home when the scan is gone).
  const [edits, setEdits] = useState<Record<string, string>>(() => scan?.edits ?? {});
  // Persist the latest edits ONCE when leaving the screen (not on every keystroke).
  // A ref keeps the newest value for the unmount cleanup; saveScanEdits no-ops if the
  // scan was validated/discarded meanwhile (findScan miss).
  const editsRef = useRef(edits);
  editsRef.current = edits;
  useEffect(() => {
    return () => {
      saveScanEdits(pendingScanId, editsRef.current);
    };
  }, [pendingScanId]);
  // Start the staged-progress clock at mount so the 3-step box advances Lecture →
  // Analyse while the run is polled. A scan opened already 'ready' never shows it.
  const [mountedAt] = useState(() => Date.now());

  // Guard: the scan was removed from the queue while this screen was open (e.g.
  // validated/discarded from another device sync) — leave silently. `closingRef` is set
  // by handleSave BEFORE completeScan removes the scan: without it this effect races the
  // save's own navigation (the queue notifies during the await → double goBack).
  const closingRef = useRef(false);
  useEffect(() => {
    const scanScopeKey = scan
      ? operatorContextKey({
          organizationId: scan.organizationId,
          actorId: scan.actorId,
          businessPortalId: scan.businessPortalId,
          tradeCode: scan.tradeCode,
        })
      : null;
    if ((!scan || !currentScopeKey || scanScopeKey !== currentScopeKey) && !closingRef.current) {
      navigation.goBack();
    }
  }, [currentScopeKey, scan, navigation]);

  const gs1 = useMemo(() => parseGs1(barcodeRaw), [barcodeRaw]);
  const fields = run?.fields ?? [];
  // The queue has already applied the backend's explicit image-quality verdict.
  // Do not recompute it here: a local heuristic could wrongly reject a valid photo.
  const requiresRecapture = queueRequiresRecapture;
  const fieldsByName = useMemo(
    () => new Map(fields.map((field) => [field.field_name, field])),
    [fields],
  );

  // Per-field autocomplete history (workflow v2.1): built ONCE at mount from the saved
  // articles (validated truth). A stable reference — rows recompute their own chips
  // from it, React.memo stays effective. Best-effort: a storage hiccup just means no
  // suggestions this session.
  const [fieldHistory, setFieldHistory] = useState<FieldHistory | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fence = await captureActiveSession();
      if (!fence || fence.scopeKey !== currentScopeKey) return;
      try {
        const articles = await getAllArticles();
        if (!cancelled && isSessionFenceCurrent(fence) && fence.scopeKey === currentScopeKey) {
          setFieldHistory(buildFieldHistory(articles));
        }
      } catch {
        // A storage/network hiccup only disables suggestions for this session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentScopeKey]);

  // Instrumentation (dev only): the photo→ready latency (docs/LATENCY-REVIEW.md §6),
  // measured from the scan's creation (workflow v1 — there is no more "Valider tap"
  // T0; the shutter itself starts the clock). Logged once per scan, the moment it's
  // found ready (which, by construction, is how the operator got to this screen).
  const loggedForScan = React.useRef<string | null>(null);
  useEffect(() => {
    if (!scan || !ready || loggedForScan.current === scan.id) return;
    loggedForScan.current = scan.id;
    logLatency('review', { wait_ms: Date.now() - Date.parse(scan.createdAt), status: 'ready' });
  }, [scan, ready]);

  // ONE stable callback for every editable row (audit §7.1): with React.memo a keystroke
  // re-renders only the row whose draft changed, not all 16.
  const handleFieldChange = useCallback((name: string, text: string) => {
    setEdits((prev) => ({ ...prev, [name]: text }));
  }, []);

  // GS1-decoded values keyed by field name — shown IN the field list at T+0 (before the
  // LLM run lands) so those rows are filled immediately rather than skeletoned (§2.1).
  const gs1Values = useMemo(() => gs1FieldValues(gs1), [gs1]);

  // Wave-2 previews, display-formatted (dates arrive canonical ISO → DD/MM/YYYY like
  // every other date on screen). GS1 stays first: a barcode-exact value is never
  // replaced by a regex preview (the backend already skips the overlap; belt+braces).
  const pendingValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(interimValues)) {
      out[name] = isDateField(name) ? displayDate(value) : value;
    }
    return { ...out, ...gs1Values };
  }, [interimValues, gs1Values]);

  // Effective value of each canonical field = the operator's draft if present, else the
  // display-formatted extracted value. A machine absence deliberately remains blank:
  // only a typed value or an explicit tap on "Marquer NC" completes it. This is exactly
  // what handleSave persists, so the counter and the backend payload cannot diverge.
  const effectiveValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const name of fieldOrder) {
      const field = fieldsByName.get(name);
      const initial = field
        ? initialHumanReviewValue(field.value, field.validation_status)
        : '';
      const permittedInitial =
        !allowsNotCommunicated(name) && initial === NOT_COMMUNICATED_VALUE ? '' : initial;
      const extracted = isDateField(name)
        ? displayDate(permittedInitial)
        : displayFieldValue(name, permittedInitial) ?? '';
      out[name] = edits[name] ?? extracted;
    }
    return out;
  }, [fieldsByName, edits, fieldOrder]);
  // Recompute from the live denomination/species drafts, not only the original OCR.
  // The proposal remains explicit: it is applied only if the operator taps it.
  const allergenSuggestion = useMemo(
    () => suggestAllergen([
      {
        field_name: 'commercial_designation',
        value: effectiveValues.commercial_designation ?? null,
      },
      {
        field_name: 'scientific_name',
        value: effectiveValues.scientific_name ?? null,
      },
      ...fields.filter((field) => field.field_name === 'product_name'),
    ]),
    [effectiveValues, fields],
  );
  // "Enregistrer l'arrivage" unlocks only when every active profile field is non-blank.
  const filledCount = useMemo(
    () => filledCountFromRun(fields, edits, reviewProfile.code),
    [edits, fields, reviewProfile.code],
  );

  // GS1 wins on lot/DLC at T+0; the backend reconciles the same way, so the values stay
  // stable once the run lands.
  const capturedAt =
    scan?.capturedAt ?? ingestion?.client_captured_at ?? ingestion?.server_received_at ?? null;

  // Ordinary review uses a plain return. A terminal unusable extraction gets a
  // dedicated recapture action below that discards the bad local workflow safely and
  // replaces this modal with the common Android/iOS Camera screen.
  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleRecapture = useCallback(async () => {
    if (!scan) return;
    const fence = await captureActiveSession();
    if (!fence || !isSessionFenceCurrent(fence) || fence.scopeKey !== currentScopeKey) return;
    // This terminal result must never reach the review outbox. Remove only the local
    // workflow/photo, then create a completely fresh idempotent ingestion from Camera.
    closingRef.current = true;
    await discardScan(scan.id);
    if (!isSessionFenceCurrent(fence)) return;
    navigation.replace('Camera', { recapture: true });
  }, [currentScopeKey, navigation, scan]);

  const handleSave = useCallback(async () => {
    if (
      requiresRecapture ||
      !run ||
      !ingestion ||
      !ingestionId ||
      !scan ||
      saveInFlightRef.current
    ) return;
    saveInFlightRef.current = true;
    const fence = await captureActiveSession();
    const scanScopeKey = operatorContextKey({
      organizationId: scan.organizationId,
      actorId: scan.actorId,
      businessPortalId: scan.businessPortalId,
      tradeCode: scan.tradeCode,
    });
    if (
      !fence ||
      !isSessionFenceCurrent(fence) ||
      !currentScopeKey ||
      fence.scopeKey !== currentScopeKey ||
      scanScopeKey !== currentScopeKey
    ) {
      saveInFlightRef.current = false;
      return;
    }
    const sessionIsCurrent = () =>
      isSessionFenceCurrent(fence) && fence.scopeKey === currentScopeKey;
    const assertCurrentSession = () => {
      if (!sessionIsCurrent()) throw new Error('MOBILE_SESSION_CHANGED');
    };
    // A scan captured by the short-lived +90° build has already reached the
    // server without physical rotation. It cannot be corrected safely after
    // OCR: ask for a new capture instead of submitting a payload the deployed
    // API rejects (and instead of confirming a wrongly oriented source photo).
    if (Number(scan.photoBaseRotationDegrees) === 90) {
      Alert.alert(
        'Photo à reprendre',
        'Cette photo a été prise avec une ancienne version de la rotation. Revenez à la liste, supprimez cet arrivage puis reprenez la photo.',
      );
      saveInFlightRef.current = false;
      return;
    }
    setSaving(true);
    setSaveFeedback(null);
    try {
      const savedFields: ArticleField[] = fieldOrder.map((name): ArticleField => {
        const extractedField = fieldsByName.get(name);
        const rawNext = normalizeFinalReviewValue(effectiveValues[name]);
        // Dates are stored CANONICAL ISO (the operator types DD/MM/YYYY; we keep
        // YYYY-MM-DD) so storage, display (displayDate) and the backend chronological gate
        // stay in sync. toIsoDate is the exact inverse of the displayDate that seeds the
        // field, so the persisted value renders back to what the operator saw (audit §7.2
        // step 4 / §4.3 / §4.4).
        const dateCanonical =
          rawNext !== NOT_COMMUNICATED_VALUE && isDateField(name)
            ? toIsoDate(rawNext)
            : rawNext;
        const nextValue = canonicalizeFinalReviewValue(name, dateCanonical);
        // Compare CANONICAL values: re-typing the same date is no longer a false "édité"
        // (audit §5 step 3 — the old code compared a DD/MM/YYYY draft to an ISO value).
        const changed = nextValue !== extractedField?.value;
        return {
          field_name: name,
          value: nextValue,
          combined_confidence: extractedField?.combined_confidence ?? 0,
          confidence_band: extractedField?.confidence_band ?? 'low',
          validation_status: 'present',
          edited: changed || undefined,
        };
      });

      // Persist the complete final review operation BEFORE the scan can leave the
      // queue. The stable key survives a kill/restart and the server commits all profile
      // values + confirmation atomically.
      let operation = scan.finalizeOpId
        ? await getOperation(scan.finalizeOpId)
        : null;
      assertCurrentSession();
      const finalReviewPayload = {
        ingestion_id: ingestionId,
        fields: Object.fromEntries(savedFields.map((field) => [field.field_name, field.value])),
        photo_rotation_degrees: photoRotationDegrees,
        photo_base_rotation_degrees: scan.photoBaseRotationDegrees ?? -90,
      };
      const validationErrors = validateFinalReviewValues(finalReviewPayload.fields);
      if (validationErrors.length > 0) {
        Alert.alert(
          'Champs à corriger',
          validationErrors
            .slice(0, 3)
            .map((error) => `${fieldLabelFr(error.fieldName)} : ${error.message}`)
            .join('\n'),
        );
        return;
      }
      if (!operation) {
        operation = await enqueueFinalizeReview(finalReviewPayload);
        assertCurrentSession();
        attachFinalizeOperation(scan.id, operation.id);
      } else {
        // A manager can correct the photo after a first offline/failed attempt.
        // Reuse the durable operation, but never resend its stale orientation.
        operation =
          (await updatePendingFinalizeReview(operation.id, finalReviewPayload, Date.now(), fence)) ??
          operation;
        assertCurrentSession();
        if (operation.status === 'dead_letter') {
          operation = await requeueDeadLetter(operation.id, Date.now(), fence);
        }
        assertCurrentSession();
        if (operation) attachFinalizeOperation(scan.id, operation.id);
      }
      await drainOutbox();
      assertCurrentSession();
      const synchronized = operation ? await getOperation(operation.id) : null;
      assertCurrentSession();
      if (synchronized?.status !== 'succeeded') {
        const serverReason = synchronized?.last_error_message?.trim();
        setSaveFeedback(
          synchronized?.status === 'dead_letter'
            ? serverReason || 'Le serveur a refusé cet arrivage. Corrigez les champs puis réessayez.'
            : 'Envoi non confirmé : l’arrivage est conservé sur cet appareil et sera renvoyé dès le retour du réseau.',
        );
        return;
      }

      // The registration projection is produced asynchronously just after the review
      // endpoint acknowledges it. Put the validated record into the catalogue cache
      // now, rather than refetching a projection that may not exist for a few seconds.
      // This makes the card visible the moment the operator returns to "Aujourd'hui";
      // the next normal or pull-to-refresh fetch reconciles it with the server copy.
      const savedAt = new Date().toISOString();
      // Start the durable copy, but do not make the user wait for it: the cropped
      // photo is already a local, durable pending file and is safe to render now.
      // Some labels are several MB, so awaiting this copy made the just-saved card
      // appear on the home page with a noticeable delay.
      const localPhotoUri = photoUri ?? null;
      const promotePhoto = localPhotoUri
        ? persistConfirmedPhoto(ingestionId, localPhotoUri, fence.scopeKey)
        : null;
      const optimisticArrival: Article = {
        id: `pending-${ingestionId}`,
        source: 'backend_extraction',
        ingestion_id: ingestionId,
        extraction_run_id: run.run_id,
        captured_at: capturedAt ?? savedAt,
        photo_uri: localPhotoUri,
        photo_rotation_degrees: photoRotationDegrees,
        photo_base_rotation_degrees: scan.photoBaseRotationDegrees ?? -90,
        barcode_raw: barcodeRaw ?? ingestion.barcode_raw ?? null,
        ingestion_status: 'confirmed',
        fields: savedFields,
        saved_at: savedAt,
        saved_by: user ?? null,
        business_portal_id: businessPortalId,
        trade_code: reviewProfile.code,
        trade_profile_version: reviewProfile.version,
        raw_extraction_run: run,
      };
      // Remove the in-progress card before publishing the final one, preventing a
      // transient duplicate. Keep its local photo until the asynchronous promotion
      // completes, so the home card can display it immediately.
      closingRef.current = true;
      await completeScan(scan.id, { keepPhoto: Boolean(localPhotoUri) });
      assertCurrentSession();
      if (!organizationId || !actorId || !businessPortalId || !tradeCode) {
        throw new Error('MOBILE_CONTEXT_MISSING');
      }
      const cacheKey = catalogQueryKey({ organizationId, actorId, businessPortalId, tradeCode });
      queryClient.setQueryData<Article[]>(cacheKey, (current = []) => [
        optimisticArrival,
        ...current.filter((article) => article.ingestion_id !== ingestionId),
      ]);
      if (promotePhoto && localPhotoUri) {
        void promotePhoto.then((confirmedPhotoUri) => {
          if (!confirmedPhotoUri) return;
          if (!sessionIsCurrent()) {
            void deleteConfirmedPhoto(confirmedPhotoUri);
            void deletePendingPhoto(localPhotoUri);
            return;
          }
          queryClient.setQueryData<Article[]>(cacheKey, (current = []) =>
            current.map((article) => article.ingestion_id === ingestionId
              ? { ...article, photo_uri: confirmedPhotoUri }
              : article),
          );
          void deletePendingPhoto(localPhotoUri);
        });
      }

      // Satisfying confirmation the arrivage was saved (light success haptic, non-blocking).
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Review opens from the home screen now — a successful save simply returns there.
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('ArticleList');
      }
    } catch (err) {
      closingRef.current = false; // stay on screen — re-arm the removed-scan guard
      if (!sessionIsCurrent()) return;
      console.error('Save error:', err);
      Alert.alert(
        "Échec de l\u2019enregistrement",
        "Impossible d\u2019enregistrer l\u2019article. Vérifiez l\u2019espace disponible.",
        [{ text: 'OK' }]
      );
    } finally {
      saveInFlightRef.current = false;
      if (sessionIsCurrent()) setSaving(false);
    }
  }, [
    run,
    ingestion,
    ingestionId,
    scan,
    edits,
    capturedAt,
    photoUri,
    barcodeRaw,
    user,
    organizationId,
    actorId,
    businessPortalId,
    currentScopeKey,
    fieldOrder,
    fieldsByName,
    reviewProfile,
    photoRotationDegrees,
    requiresRecapture,
      navigation,
  ]);

  // Save is gated on full profile completion: the arrivage is only recorded — and counted —
  // once every field is filled. Below that the button stays disabled and reads "Compléter
  // (n/total)"; the modifications made so far are still persisted on leave.
  const complete = filledCount === fieldOrder.length;
  const waitingForSync = scan?.reviewSyncStatus === 'pending';
  const canSave =
    !requiresRecapture &&
    ready &&
    run != null &&
    ingestion != null &&
    complete;
  const showFinalFieldProjection =
    ready ||
    requiresRecapture ||
    scan?.status === 'submit_error' ||
    scan?.status === 'extract_error';

  return (
    <View style={styles.root}>
      {/* Fixed photo header — SAME system as ArticleDetail: the photo stays put while the
          content sheet scrolls over it. RotatedPhoto composes the capture base with the
          manager-approved half-turn exactly as every final display does. Tap the photo to
          open it full-screen; the return control is the bottom action bar. */}
      <View style={styles.photoContainer}>
        {photoUri ? (
          <Pressable
            onPress={() => setViewerOpen(true)}
            style={styles.photoCard}
            accessibilityRole="button"
            accessibilityLabel="Voir la photo en plein écran"
          >
            <RotatedPhoto
              source={{ uri: photoUri }}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
              halfTurn={photoRotationDegrees === 180}
              baseRotationDegrees={scan.photoBaseRotationDegrees ?? -90}
            />
          </Pressable>
        ) : (
          <View style={[styles.photoCard, styles.photoPlaceholder]}>
            <MaterialCommunityIcons name="image-off-outline" size={48} color={colors.onSurfaceVariant} />
          </View>
        )}
      </View>

      <PhotoViewerModal
        visible={viewerOpen}
        photoUri={photoUri}
        allowHalfTurn
        halfTurn={photoRotationDegrees === 180}
        baseRotationDegrees={scan?.photoBaseRotationDegrees ?? -90}
        onHalfTurn={() => {
          const next = photoRotationDegrees === 0 ? 180 : 0;
          setPhotoRotationDegrees(next);
          saveScanPhotoRotation(pendingScanId, next);
        }}
        onClose={() => setViewerOpen(false)}
      />

      <ScrollView
        style={styles.contentCard}
        contentContainerStyle={styles.contentInner}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* Épuré au maximum : au plus l'admin + la date d'enregistrement, un point. */}
        {user || capturedAt ? (
          <Text style={[typography.bodySmall, styles.metaLine]} numberOfLines={1}>
            {[reviewProfile.displayName, user, capturedAt ? formatDate(capturedAt) : null]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        ) : null}

        {requiresRecapture ? (
            <View style={[styles.ocrCard, styles.recaptureCard]} accessibilityRole="alert">
              <View style={styles.recaptureTitleRow}>
                <MaterialCommunityIcons name="camera-retake-outline" size={22} color={colors.error} />
                <Text style={[typography.titleMedium, styles.recaptureTitle]}>
                  {RECAPTURE_TITLE}
                </Text>
              </View>
              <Text style={[typography.bodyMedium, styles.recaptureMessage]}>
                {RECAPTURE_MESSAGE}
              </Text>
              <Text style={[typography.bodyMedium, styles.recaptureGuidance]}>
                {RECAPTURE_GUIDANCE}
              </Text>
            </View>
          ) : null}
        {!requiresRecapture && (scan?.status === 'submit_error' || scan?.status === 'extract_error') ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                {scan.status === 'submit_error'
                  ? `L’envoi de cette étiquette a échoué${scan.errorCode ? ` (${scan.errorCode})` : ''}. Revenez à l’accueil pour réessayer.`
                  : 'L’analyse de cette étiquette a échoué. Revenez à l’accueil pour réessayer.'}
              </Text>
            </View>
          ) : null}
        {!requiresRecapture && ready && run == null ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                Impossible de charger les champs extraits. L'étiquette a été traitée sur le serveur
                (statut : {ingestion ? ingestionStatusFr(ingestion.status) : '—'}).
              </Text>
            </View>
          ) : null}
        {!requiresRecapture && ready && fields.length === 0 ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                Aucun champ extrait.
              </Text>
            </View>
          ) : null}

        {/* Alerts never replace the contract: every profile row stays visible. A machine
            absence stays blank/à vérifier until the operator explicitly supplies a value
            or marks it NC. */}
        {!requiresRecapture && !showFinalFieldProjection ? (
          <ExtractionProgress
            startedAt={mountedAt}
            ready={false}
            uploadDone={scan?.status !== 'submitting'}
            ocrDone={ocrDone}
            analysisLabel={
              reviewProfile.code === 'poissonnerie'
                ? 'Analyse de l’espèce'
                : reviewProfile.code === 'boucherie'
                  ? 'Analyse de la viande'
                  : 'Analyse du produit préparé'
            }
          />
        ) : null}
        {!requiresRecapture ? fieldGroups.map((group) => (
                <View key={group.id} style={styles.fieldGroup}>
                  <View style={styles.fieldGroupHeader}>
                    <View style={styles.fieldGroupIcon}>
                      <MaterialCommunityIcons
                        name={FIELD_GROUP_ICON[group.id]}
                        size={17}
                        color={colors.primary}
                      />
                    </View>
                    <Text style={[typography.labelLarge, styles.fieldGroupTitle]}>
                      {group.title}
                    </Text>
                  </View>
                  <View style={styles.fieldGroupCard}>
                    {group.fields.map((name) => {
                      const field = fieldsByName.get(name);
                      const editableField: ExtractionField | null = field ?? (showFinalFieldProjection ? {
                        field_name: name,
                        value: null,
                        evidence: [],
                        provenance: null,
                        source_raw_artifact_id: null,
                        validation_status: 'missing',
                        warnings: null,
                        llm_confidence: null,
                        ocr_confidence: null,
                        combined_confidence: 0,
                        confidence_band: 'low',
                        source: 'missing',
                        created_at: '',
                      } : null);
                      if (editableField) {
                        return (
                          <EditableFieldRow
                            key={name}
                            field={editableField}
                            draft={effectiveValues[name]}
                            onChange={handleFieldChange}
                            suggestion={name === 'allergens' ? allergenSuggestion : undefined}
                            history={fieldHistory}
                            edited={Object.prototype.hasOwnProperty.call(edits, name)}
                          />
                        );
                      }
                      return (
                        <PendingFieldRow
                          key={name}
                          fieldName={name}
                          gs1Value={pendingValues[name]}
                        />
                      );
                    })}
                  </View>
                </View>
        )) : null}
      </ScrollView>

      {saveFeedback ? (
        <View style={styles.saveFeedback} accessibilityRole="alert">
          <MaterialCommunityIcons name="information-outline" size={18} color={colors.onPrimaryContainer} />
          <Text style={[typography.bodySmall, styles.saveFeedbackText]}>{saveFeedback}</Text>
        </View>
      ) : null}

        <View style={[styles.actionRow, { paddingBottom: insets.bottom + spacing.md }]}>
          <Pressable
            onPress={handleBack}
            style={styles.retakeButton}
            android_ripple={{ color: colors.primaryContainer }}
            accessibilityRole="button"
            accessibilityLabel="Revenir à la liste"
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={18}
              color={colors.primary}
              style={{ marginRight: spacing.xs }}
            />
            <Text style={[typography.labelLarge, { color: colors.primary }]}>Retour</Text>
          </Pressable>

          <Pressable
            onPress={requiresRecapture ? handleRecapture : canSave ? handleSave : undefined}
            disabled={requiresRecapture ? false : !canSave || saving}
            style={[
              styles.saveButton,
              requiresRecapture && styles.recaptureButton,
              !requiresRecapture && (!canSave || saving) && styles.saveButtonDisabled,
            ]}
            android_ripple={{ color: colors.primaryContainer }}
            accessibilityRole="button"
            accessibilityLabel={requiresRecapture ? 'Reprendre la photo' : 'Enregistrer l’arrivage'}
          >
            <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
              {requiresRecapture
                ? 'Reprendre la photo'
                : saving
                  ? 'Enregistrement…'
                  : waitingForSync
                    ? 'Réessayer la synchronisation'
                    : scan?.reviewSyncStatus === 'dead_letter'
                      ? 'Réessayer l’envoi'
                      : !ready
                        ? 'Analyse en cours…'
                        : !complete
                          ? `Compléter (${filledCount}/${fieldOrder.length})`
                          : 'Enregistrer l’arrivage'}
            </Text>
          </Pressable>
        </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Fixed photo header (same system as ArticleDetail): the photo stays put while the
  // content sheet scrolls over it. A tap opens PhotoViewerModal at full resolution.
  photoContainer: {
    height: PHOTO_HEIGHT_LANDSCAPE,
    position: 'relative',
    backgroundColor: colors.onSurface,
  },
  photoCard: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Content sheet — rises over the bottom of the fixed photo with a rounded top
  // (same overlap as ArticleDetail), then scrolls its fields internally.
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
  // The single allowed meta line: admin · date d'enregistrement. Nothing else.
  metaLine: {
    color: colors.onSurfaceVariant,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  ocrCard: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  recaptureCard: {
    borderWidth: 1,
    borderColor: colors.error,
  },
  recaptureTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  recaptureTitle: {
    color: colors.error,
  },
  recaptureMessage: {
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  recaptureGuidance: {
    color: colors.onSurfaceVariant,
  },
  recaptureButton: {
    backgroundColor: colors.error,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  fieldGroupHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  fieldGroupIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldGroupTitle: {
    flex: 1,
    color: colors.onSurface,
  },
  fieldGroupCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    paddingHorizontal: spacing.md,
    overflow: 'hidden',
  },
  // One row layout shared by read-only and editable fields, so the list reads as a
  // single homogeneous column.
  fieldRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  fieldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  fieldName: {
    color: colors.onSurfaceVariant,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  // Human-review tag — brand tinted, shown only while the field is empty.
  attentionTag: {
    color: colors.onPrimaryContainer,
    backgroundColor: colors.primaryContainer,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  input: {
    color: colors.onSurface,
    backgroundColor: colors.surfaceContainer,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  // Empty-field highlight — a soft brand tint + accent border; disappears once filled.
  inputHighlighted: {
    backgroundColor: colors.primaryContainer,
    borderColor: colors.primary,
  },
  // Neutral, non-blocking validity hint under an input (Clean UI: never red/alarmist).
  inputHint: {
    color: colors.onSurfaceVariant,
    marginTop: spacing.xs,
  },
  notCommunicatedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  notCommunicatedChipText: {
    color: colors.primary,
  },
  reviewDecisionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  confirmSuggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    overflow: 'hidden',
  },
  confirmSuggestionChipText: {
    color: colors.onPrimary,
  },
  saveFeedback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primaryContainer,
  },
  saveFeedbackText: {
    flex: 1,
    color: colors.onPrimaryContainer,
  },
  // Allergen suggestion pill (chantier B) — a discreet, tappable primary-tinted chip
  // shown under the (empty) allergens input. Tapping it fills the field as a human edit.
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryContainer,
  },
  suggestionChipText: {
    color: colors.onPrimaryContainer,
  },
  // History autocomplete chips (workflow v2.1) — quieter than the allergen compliance
  // chip (neutral surface, no accent border): these are recall aids, not guidance.
  historyChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  historyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    backgroundColor: colors.surfaceContainer,
  },
  historyChipText: {
    color: colors.onSurface,
    flexShrink: 1,
  },
  // Unit-affix inputs (weight: [amount] kg/g ; temperature: [min] – [max] °C).
  affixRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  affixInput: {
    flex: 1,
    color: colors.onSurface,
    backgroundColor: colors.surfaceContainer,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    textAlign: 'center',
  },
  affixInputHighlighted: {
    backgroundColor: colors.primaryContainer,
    borderColor: colors.primary,
  },
  affixUnitToggle: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceContainerHigh,
    minWidth: 44,
    alignItems: 'center',
  },
  affixUnitText: {
    color: colors.onSurfaceVariant,
  },
  affixDash: {
    color: colors.onSurfaceVariant,
    paddingHorizontal: spacing.xs,
  },
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  saveButton: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
    ...elevation[2],
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
});
