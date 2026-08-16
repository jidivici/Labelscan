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

import { getAllArticles, persistConfirmedPhoto } from '../services/storage';
import { queryClient } from '../services/queryClient';
import { businessProfileFor } from '../services/businessProfiles';
import { suggestAllergen } from '../services/allergenSuggestions';
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
  parsePrice,
  formatPrice,
  validateDate,
  validateTempRange,
  validateWeight,
  isHealthMarkField,
  maskHealthMark,
  validateHealthMark,
  type WeightUnit,
} from '../services/inputMasks';
import { fieldLabelFr, ingestionStatusFr } from '../services/fieldLabels';
import { parseGs1, gs1FieldValues } from '../services/gs1';
import { useScan } from '../hooks/useScanQueue';
import {
  attachFinalizeOperation,
  completeScan,
  saveScanEdits,
  saveScanPhotoRotation,
} from '../services/scanQueue';
import { filledCountFromValues } from '../services/fieldCompleteness';
import { SkeletonValue } from '../components/SkeletonFieldList';
import { PhotoViewerModal } from '../components/PhotoViewerModal';
import { RotatedPhoto } from '../components/RotatedPhoto';
import { ExtractionProgress } from '../components/ExtractionProgress';
import { formatDate } from '../services/dates';
import { logLatency } from '../services/latencyLog';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, radius, typography, elevation } from '../theme';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { ExtractionField } from '../types/api';
import type { Article, ArticleField } from '../types/Article';

type RouteType = RouteProp<RootStackParamList, 'Review'>;
type NavProp = StackNavigationProp<RootStackParamList, 'Review'>;
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const FIELD_GROUP_ICON: Record<string, IconName> = {
  identity: 'food-variant',
  provenance: 'map-marker-radius-outline',
  traceability: 'shield-check-outline',
  haccp: 'clipboard-check-outline',
  commercial: 'scale-balance',
};

// Landscape photo height at the top of the review — wide and low so the whole label
// reads landscape, leaving maximum room for the field list below (coherence request).
const PHOTO_HEIGHT_LANDSCAPE = 200;

// ── Server extraction — single homogeneous editable list ──────────────────────────

// Empty fields get a brand-tinted "à compléter" highlight, computed from the live
// draft inside EditableFieldRow (so it clears the instant a value is typed). We
// deliberately do NOT surface AI confidence or an "à vérifier" flag: manual validation
// is the single source of truth (CLAUDE.md "Clean UI Radicale", audit §6.2).

// Canonical display order for the 17 fields. The SAME order drives the loading skeleton
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
}: {
  draft: string;
  onChange: (text: string) => void;
  highlighted: boolean;
}) {
  const seed = parseWeight(draft);
  const [amount, setAmount] = useState(seed.amount);
  const [unit, setUnit] = useState<WeightUnit>(seed.unit);

  return (
    <View style={styles.affixRow}>
      <TextInput
        value={amount}
        onChangeText={(t) => {
          const v = t.replace(/[^0-9.,]/g, '');
          setAmount(v);
          onChange(formatWeight(v, unit));
        }}
        keyboardType="decimal-pad"
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
}: {
  draft: string;
  onChange: (text: string) => void;
  highlighted: boolean;
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
        keyboardType="numbers-and-punctuation"
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
        keyboardType="numbers-and-punctuation"
        placeholder="max"
        placeholderTextColor={colors.onSurfaceVariant}
        style={[typography.bodyMedium, styles.affixInput, highlighted ? styles.affixInputHighlighted : null]}
        accessibilityLabel="Température maximale"
      />
      <Text style={[typography.labelLarge, styles.affixUnitText]}>°C</Text>
    </View>
  );
}

/**
 * Price field: numeric input with a currency affix (defaults to € / EUR — the criée
 * standard). Local amount state seeded once from the draft. Emits "amount currency"
 * (e.g. "8.95 EUR"), so the stored value keeps the LLM's canonical price form.
 */
function PriceInput({
  draft,
  onChange,
  highlighted,
}: {
  draft: string;
  onChange: (text: string) => void;
  highlighted: boolean;
}) {
  const seed = parsePrice(draft);
  const [amount, setAmount] = useState(seed.amount);
  const currency = seed.currency; // follows the extracted value; shown as a static affix

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
        style={[typography.bodyMedium, styles.affixInput, highlighted ? styles.affixInputHighlighted : null]}
        accessibilityLabel="Prix"
      />
      <Text style={[typography.labelLarge, styles.affixUnitText]}>
        {currency === 'EUR' ? '€' : currency}
      </Text>
    </View>
  );
}

const EditableFieldRow = React.memo(function EditableFieldRow({
  field,
  draft,
  onChange,
  suggestion,
  history,
}: {
  field: ExtractionField;
  draft: string;
  // (name, text) so the parent keeps ONE stable callback for all rows — combined with
  // React.memo, a keystroke then re-renders ONLY the edited row (audit §7.1).
  onChange: (name: string, text: string) => void;
  suggestion?: string | null;
  /** Per-field autocomplete history (workflow v2.1) — STABLE reference, built once. */
  history?: FieldHistory | null;
}) {
  // "À compléter" highlight is REACTIVE to the live draft (not the server value): an
  // empty field is highlighted with the brand tint, which vanishes as soon as it is filled.
  const empty = draft.trim() === '';
  // A suggestion is offered only while the field is still empty; it never overrides a
  // typed/extracted value and is applied only on tap (→ a human edit on save).
  const showSuggestion = !!suggestion && empty;
  // Bind this row's field name once; the affix inputs and the suggestion chip emit through it.
  const emit = (text: string) => onChange(field.field_name, text);
  // Date fields: number-pad + a DD/MM/YYYY mask (auto "/"). An INPUT helper that
  // formats the digits the operator reads off the label — it never computes a date.
  const isDate = isDateField(field.field_name);
  // Health mark ("estampille sanitaire"): the official stamp is always uppercase, so
  // every keystroke is force-cased — never a stripped/computed character.
  const isHealthMark = isHealthMarkField(field.field_name);
  const handleChange = (text: string) =>
    emit(isDate ? maskDate(text) : isHealthMark ? maskHealthMark(text) : text);
  // History autocomplete (workflow v2.1): chips shown ONLY while this row's input is
  // focused, so the 16 other rows never render suggestion clutter. suggestForField
  // returns [] for non-history fields (dates, lot, gtin, affix inputs) — no per-field
  // wiring needed here. Applying a chip goes through emit → a HUMAN edit, exactly like
  // typing it (no-fabrication gate untouched).
  const [focused, setFocused] = useState(false);
  const historySuggestions =
    focused && history ? suggestForField(history, field.field_name, draft) : [];

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
        {empty ? (
          <Text style={[typography.labelSmall, styles.attentionTag]}>À compléter</Text>
        ) : null}
      </View>
      {field.field_name === 'weight' ? (
        <WeightInput draft={draft} onChange={emit} highlighted={empty} />
      ) : field.field_name === 'storage_temperature' ? (
        <TempRangeInput draft={draft} onChange={emit} highlighted={empty} />
      ) : field.field_name === 'price' ? (
        <PriceInput draft={draft} onChange={emit} highlighted={empty} />
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
            empty ? styles.inputHighlighted : null,
          ]}
          autoCapitalize={isHealthMark ? 'characters' : 'words'}
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel={`Champ ${fieldLabelFr(field.field_name)}`}
        />
      )}
      {hint ? <Text style={[typography.labelSmall, styles.inputHint]}>{hint}</Text> : null}
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
  const { user, businessPortalId, tradeCode } = useAuth();
  const { pendingScanId } = route.params;

  // Single source of truth (workflow v1): photo, barcode, ingestion id and the
  // extraction result are read LIVE from the scan queue, never carried through
  // navigation — this screen always reflects the queue's current truth, whether it
  // mounted while the scan was still extracting or already ready.
  const { scan, result, interimValues } = useScan(pendingScanId);
  const ocrDone = scan?.ocrDone === true;
  const ready = scan?.status === 'ready';
  const ingestion = result?.ingestion ?? null;
  const run = result?.run ?? null;
  const ingestionId = scan?.ingestionId ?? null;
  const photoUri = scan?.photoUri;
  const barcodeRaw = scan?.barcodeRaw;
  const reviewProfile = businessProfileFor(scan?.tradeCode ?? tradeCode);
  const fieldGroups = reviewProfile.groups;
  const fieldOrder = reviewProfile.fields;

  const [saving, setSaving] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [photoRotationDegrees, setPhotoRotationDegrees] = useState<0 | 180>(scan?.photoRotationDegrees ?? 0);
  // Workflow v2 "session": seed the draft from the scan's persisted edits so a
  // partially-filled arrivage is restored on re-open (the scan stays "en cours" until
  // all 17 fields are filled and validated). Lazy init — the queue is already hydrated
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
    if (!scan && !closingRef.current) navigation.goBack();
  }, [scan, navigation]);

  const gs1 = useMemo(() => parseGs1(barcodeRaw), [barcodeRaw]);
  const fields = run?.fields ?? [];

  // Per-field autocomplete history (workflow v2.1): built ONCE at mount from the saved
  // articles (validated truth). A stable reference — rows recompute their own chips
  // from it, React.memo stays effective. Best-effort: a storage hiccup just means no
  // suggestions this session.
  const [fieldHistory, setFieldHistory] = useState<FieldHistory | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAllArticles()
      .then((articles) => {
        if (!cancelled) setFieldHistory(buildFieldHistory(articles));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Allergen decision-support (chantier B): derive ONE EU-family suggestion from the
  // species/product fields. Pure + returns null when unsure (mixed/empty). It is shown
  // only on the `allergens` row and only while that row is still empty; accepting it
  // records a HUMAN edit (source='human' on save), never an extracted value — the
  // no-fabrication gate is untouched. See services/allergenSuggestions.ts.
  const allergenSuggestion = useMemo(() => suggestAllergen(fields), [fields]);

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
  // display-formatted extracted value. This is exactly what handleSave will persist, so
  // it drives the 17/17 completeness gate (workflow v2) AND seeds each editable row (no
  // divergence between the count and what's on screen).
  const effectiveValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const name of fieldOrder) {
      const field = fields.find((f) => f.field_name === name);
      const extracted = field
        ? isDateField(name)
          ? displayDate(field.value ?? '')
          : field.value ?? ''
        : '';
      out[name] = edits[name] ?? extracted;
    }
    return out;
  }, [fields, edits, fieldOrder]);
  // How many of the 17 fields are filled (non-blank). "Enregistrer l'arrivage" unlocks
  // only at 17/17 — until then the arrivage stays "en cours" and is never counted.
  const filledCount = useMemo(
    () => filledCountFromValues(effectiveValues, reviewProfile.code),
    [effectiveValues, reviewProfile.code],
  );

  // GS1 wins on lot/DLC at T+0; the backend reconciles the same way, so the values stay
  // stable once the run lands.
  const capturedAt =
    scan?.capturedAt ?? ingestion?.client_captured_at ?? ingestion?.server_received_at ?? null;

  // No more "Reprendre": Review no longer sits above a live Camera to reshoot onto —
  // it opens from the home screen, so the back control is a plain return. Re-shooting
  // a bad photo means discarding the card at home and scanning again.
  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleSave = useCallback(async () => {
    if (!run || !ingestion || !ingestionId || !scan) return;
    // A scan captured by the short-lived +90° build has already reached the
    // server without physical rotation. It cannot be corrected safely after
    // OCR: ask for a new capture instead of submitting a payload the deployed
    // API rejects (and instead of confirming a wrongly oriented source photo).
    if (Number(scan.photoBaseRotationDegrees) === 90) {
      Alert.alert(
        'Photo à reprendre',
        'Cette photo a été prise avec une ancienne version de la rotation. Revenez à la liste, supprimez cet arrivage puis reprenez la photo.',
      );
      return;
    }
    setSaving(true);
    try {
      const savedFields: ArticleField[] = run.fields.map((f): ArticleField => {
        const draft = edits[f.field_name];
        const hasEdit = draft !== undefined;
        const rawNext = hasEdit ? (draft.trim() === '' ? null : draft.trim()) : f.value;
        // Dates are stored CANONICAL ISO (the operator types DD/MM/YYYY; we keep
        // YYYY-MM-DD) so storage, display (displayDate) and the backend chronological gate
        // stay in sync. toIsoDate is the exact inverse of the displayDate that seeds the
        // field, so the persisted value renders back to what the operator saw (audit §7.2
        // step 4 / §4.3 / §4.4).
        const nextValue =
          rawNext != null && isDateField(f.field_name) ? toIsoDate(rawNext) : rawNext;
        // Compare CANONICAL values: re-typing the same date is no longer a false "édité"
        // (audit §5 step 3 — the old code compared a DD/MM/YYYY draft to an ISO value).
        const changed = hasEdit && nextValue !== f.value;
        return {
          field_name: f.field_name,
          value: nextValue,
          combined_confidence: f.combined_confidence,
          confidence_band: f.confidence_band,
          validation_status: changed
            ? nextValue == null
              ? 'missing'
              : 'present'
            : f.validation_status,
          edited: changed || undefined,
        };
      });

      // Persist the complete final review operation BEFORE the scan can leave the
      // queue. The stable key survives a kill/restart and the server commits all 17
      // values + confirmation atomically.
      let operation = scan.finalizeOpId
        ? await getOperation(scan.finalizeOpId)
        : null;
      const finalReviewPayload = {
        ingestion_id: ingestionId,
        fields: Object.fromEntries(
          fieldOrder.map((name) => [
            name,
            savedFields.find((field) => field.field_name === name)?.value ?? null,
          ]),
        ),
        photo_rotation_degrees: photoRotationDegrees,
        photo_base_rotation_degrees: scan.photoBaseRotationDegrees ?? -90,
      };
      if (!operation) {
        operation = await enqueueFinalizeReview(finalReviewPayload);
        attachFinalizeOperation(scan.id, operation.id);
      } else {
        // A manager can correct the photo after a first offline/failed attempt.
        // Reuse the durable operation, but never resend its stale orientation.
        operation = (await updatePendingFinalizeReview(operation.id, finalReviewPayload)) ?? operation;
        if (operation.status === 'dead_letter') {
          operation = await requeueDeadLetter(operation.id);
        }
        if (operation) attachFinalizeOperation(scan.id, operation.id);
      }
      await drainOutbox();
      const synchronized = operation ? await getOperation(operation.id) : null;
      if (synchronized?.status !== 'succeeded') {
        Alert.alert(
          'En attente de synchronisation',
          synchronized?.status === 'dead_letter'
            ? 'L’envoi a échoué après plusieurs tentatives. Vous pourrez le reprendre depuis cette fiche.'
            : 'L’arrivage reste conservé sur cet appareil et sera envoyé automatiquement dès que le réseau revient.',
        );
        return;
      }

      // The registration projection is produced asynchronously just after the review
      // endpoint acknowledges it. Put the validated record into the catalogue cache
      // now, rather than refetching a projection that may not exist for a few seconds.
      // This makes the card visible the moment the operator returns to "Aujourd'hui";
      // the next normal or pull-to-refresh fetch reconciles it with the server copy.
      const savedAt = new Date().toISOString();
      const confirmedPhotoUri = photoUri
        ? await persistConfirmedPhoto(ingestionId, photoUri)
        : null;
      const optimisticArrival: Article = {
        id: `pending-${ingestionId}`,
        source: 'backend_extraction',
        ingestion_id: ingestionId,
        extraction_run_id: run.run_id,
        captured_at: capturedAt ?? savedAt,
        photo_uri: confirmedPhotoUri,
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
      // transient duplicate. The photo has already been copied to permanent storage.
      closingRef.current = true;
      await completeScan(scan.id);
      queryClient.setQueryData<Article[]>(['catalog', 'arrivals'], (current = []) => [
        optimisticArrival,
        ...current.filter((article) => article.ingestion_id !== ingestionId),
      ]);

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
      console.error('Save error:', err);
      Alert.alert(
        "Échec de l\u2019enregistrement",
        "Impossible d\u2019enregistrer l\u2019article. Vérifiez l\u2019espace disponible.",
        [{ text: 'OK' }]
      );
    } finally {
      setSaving(false);
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
    businessPortalId,
    fieldOrder,
    reviewProfile,
    photoRotationDegrees,
    navigation,
  ]);

  // Save is gated on 17/17 (workflow v2): the arrivage is only recorded — and counted —
  // once every field is filled. Below that the button stays disabled and reads "Compléter
  // (n/17)"; the modifications made so far are still persisted on leave.
  const complete = filledCount === fieldOrder.length;
  const waitingForSync = scan?.reviewSyncStatus === 'pending';
  const canSave =
    ready &&
    run != null &&
    ingestion != null &&
    complete &&
    !waitingForSync;

  return (
    <View style={styles.root}>
      {/* Fixed photo header — SAME system as ArticleDetail: the photo stays put while the
          content sheet scrolls over it. The stored OCR source keeps its capture orientation;
          RotatedPhoto applies the single left rotation used by every final display. Tap the
          photo to open it full-screen; the return control is the bottom action bar. */}
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
              style={StyleSheet.absoluteFillObject}
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

          {scan?.status === 'submit_error' || scan?.status === 'extract_error' ? (
            // Defensive only — a card in error state is not tappable from home, so this
            // normally can't be reached; kept in case the scan regresses while open.
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                {scan.status === 'submit_error'
                  ? 'L’envoi de cette étiquette a échoué. Revenez à l’accueil pour réessayer.'
                  : 'L’analyse de cette étiquette a échoué. Revenez à l’accueil pour réessayer.'}
              </Text>
            </View>
          ) : ready && run == null ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                Impossible de charger les champs extraits. L'étiquette a été traitée sur le serveur
                (statut : {ingestion ? ingestionStatusFr(ingestion.status) : '—'}).
              </Text>
            </View>
          ) : ready && fields.length === 0 ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                Aucun champ extrait.
              </Text>
            </View>
          ) : (
            // Photo + (chargement) + champs. Le plus simple possible : une liste STABLE
            // en FIELD_ORDER, lignes GS1/interim préremplies, le reste en skeleton en
            // place, qui deviennent éditables au ready — SANS cascade, sans compteur.
            <>
              {ready ? null : (
                <ExtractionProgress
                  startedAt={mountedAt}
                  ready={false}
                  ocrDone={ocrDone}
                  analysisLabel={
                    reviewProfile.code === 'poissonnerie'
                      ? 'Analyse de l’espèce'
                      : reviewProfile.code === 'boucherie'
                        ? 'Analyse de la viande'
                        : 'Analyse du produit préparé'
                  }
                />
              )}
              {fieldGroups.map((group) => (
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
                      const field = fields.find((item) => item.field_name === name);
                      if (field) {
                        return (
                          <EditableFieldRow
                            key={name}
                            field={field}
                            draft={effectiveValues[name]}
                            onChange={handleFieldChange}
                            suggestion={name === 'allergens' ? allergenSuggestion : undefined}
                            history={fieldHistory}
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
              ))}
            </>
          )}
      </ScrollView>

        <View style={[styles.actionRow, { paddingBottom: insets.bottom + spacing.md }]}>
          <Pressable
            onPress={handleBack}
            style={styles.retakeButton}
            android_ripple={{ color: colors.primaryContainer }}
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
            onPress={canSave ? handleSave : undefined}
            disabled={!canSave || saving}
            style={[styles.saveButton, (!canSave || saving) && styles.saveButtonDisabled]}
            android_ripple={{ color: colors.primaryContainer }}
          >
            <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
              {saving
                ? 'Enregistrement…'
                : waitingForSync
                  ? 'En attente de synchronisation'
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
    ...StyleSheet.absoluteFillObject,
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
  // "À compléter" tag — brand tinted, shown only while the field is empty.
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
