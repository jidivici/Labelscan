/**
 * ReviewScreen — the single review/edit path (workflow v1).
 *
 * Opened from the home screen's "En cours" section for one queued scan (by
 * `pendingScanId`); reads its photo/barcode/extraction result LIVE from the scan
 * queue (useScan) rather than from navigation params, so it always reflects the
 * queue's current truth. Displays the server extraction result (status + per-field
 * value/confidence/validation_status) and saves a backend Article via
 * saveBackendArticle, then removes the scan from the queue.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Pressable,
  Alert,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { saveBackendArticle } from '../services/storage';
import { FIELD_ORDER } from '../services/fieldOrder';
import { suggestAllergen } from '../services/allergenSuggestions';
import { submitFieldOverrides } from '../services/fieldOverrideSubmit';
import { enqueueConfirmIngestion } from '../services/outbox';
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
  type WeightUnit,
} from '../services/inputMasks';
import { fieldLabelFr, ingestionStatusFr } from '../services/fieldLabels';
import { parseGs1, formatGs1WeightKg, gs1FieldValues } from '../services/gs1';
import { useScan } from '../hooks/useScanQueue';
import { completeScan } from '../services/scanQueue';
import { SkeletonValue } from '../components/SkeletonFieldList';
import { PhotoViewerModal } from '../components/PhotoViewerModal';
import { CascadeReveal, cascadeDelay } from '../components/CascadeReveal';
import { ExtractionProgress } from '../components/ExtractionProgress';
import { formatDate } from '../services/dates';
import { logLatency } from '../services/latencyLog';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, radius, typography, elevation } from '../theme';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { ExtractionField } from '../types/api';
import type { ArticleField } from '../types/Article';

type RouteType = RouteProp<RootStackParamList, 'Review'>;
type NavProp = StackNavigationProp<RootStackParamList, 'Review'>;

// ── Server extraction — single homogeneous editable list ──────────────────────────

// A field "needs attention" only when it is EMPTY (a value to fill in). We deliberately
// do NOT surface AI confidence or an "à vérifier" flag here: manual validation is the
// single source of truth (CLAUDE.md "Clean UI Radicale", audit §6.2). The highlight is
// purely a fill-in affordance, never a quality judgement on an extracted value.
function needsReview(field: ExtractionField): boolean {
  return field.value == null || field.value === '';
}

// Canonical display order for the 16 fields. The SAME order drives the loading skeleton
// list AND the ready list, so rows never reshuffle when the run lands (audit §2.2 — zero
// layout shift). Readable HACCP order: identity → method/origin → lot/dates → conservation.
// FIELD_ORDER now lives in services/fieldOrder.ts — SHARED with ArticleDetailScreen so the
// app reads fields in ONE consistent order (registration ⇄ detail).

/**
 * One placeholder row in the stable list while the LLM run is still loading: the real
 * field LABEL is shown, and the VALUE is the GS1-decoded value (T+0), the Tier 3 wave-2
 * deterministic preview (~OCR done), or a pulsing skeleton. Same geometry as
 * EditableFieldRow → swapping it in at ready does not move anything (audit §2.1/2.2).
 * A value that ARRIVES (skeleton → GS1/preview) reveals through CascadeReveal, keyed on
 * the value so the animation runs exactly once per reveal, staggered by row position.
 */
function PendingFieldRow({
  fieldName,
  gs1Value,
  revealDelay = 0,
}: {
  fieldName: string;
  gs1Value?: string;
  revealDelay?: number;
}) {
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldHeader}>
        <Text style={[typography.labelSmall, styles.fieldName]}>{fieldLabelFr(fieldName)}</Text>
      </View>
      {gs1Value != null ? (
        <CascadeReveal key={gs1Value} delay={revealDelay}>
          <View style={styles.input}>
            <Text style={[typography.bodyMedium, { color: colors.onSurface }]}>{gs1Value}</Text>
          </View>
        </CascadeReveal>
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
  highlighted,
  suggestion,
}: {
  field: ExtractionField;
  draft: string;
  // (name, text) so the parent keeps ONE stable callback for all rows — combined with
  // React.memo, a keystroke then re-renders ONLY the edited row (audit §7.1).
  onChange: (name: string, text: string) => void;
  highlighted: boolean;
  suggestion?: string | null;
}) {
  // A suggestion is offered only while the field is still empty; it never overrides a
  // typed/extracted value and is applied only on tap (→ a human edit on save).
  const showSuggestion = !!suggestion && draft.trim() === '';
  // Bind this row's field name once; the affix inputs and the suggestion chip emit through it.
  const emit = (text: string) => onChange(field.field_name, text);
  // Date fields: number-pad + a DD/MM/YYYY mask (auto "/"). An INPUT helper that
  // formats the digits the operator reads off the label — it never computes a date.
  const isDate = isDateField(field.field_name);
  const handleChange = (text: string) => emit(isDate ? maskDate(text) : text);
  // Real-time, NEUTRAL, non-blocking validity hint (Clean UI: no red, never blocks the
  // save). Computed from the live draft so it updates as the operator types; null while
  // the value is empty, valid, or still being typed.
  let hint: string | null = null;
  if (isDate) hint = validateDate(draft);
  else if (field.field_name === 'weight') hint = validateWeight(parseWeight(draft).amount);
  else if (field.field_name === 'storage_temperature') {
    const t = parseTemp(draft);
    hint = validateTempRange(t.min, t.max);
  }
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldHeader}>
        <Text style={[typography.labelSmall, styles.fieldName]}>{fieldLabelFr(field.field_name)}</Text>
        {highlighted ? (
          <Text style={[typography.labelSmall, styles.attentionTag]}>À compléter</Text>
        ) : null}
      </View>
      {field.field_name === 'weight' ? (
        <WeightInput draft={draft} onChange={emit} highlighted={highlighted} />
      ) : field.field_name === 'storage_temperature' ? (
        <TempRangeInput draft={draft} onChange={emit} highlighted={highlighted} />
      ) : field.field_name === 'price' ? (
        <PriceInput draft={draft} onChange={emit} highlighted={highlighted} />
      ) : (
        <TextInput
          value={draft}
          onChangeText={handleChange}
          keyboardType={isDate ? 'number-pad' : 'default'}
          maxLength={isDate ? 10 : undefined}
          placeholder={isDate ? 'JJ/MM/AAAA' : highlighted ? 'Saisir la valeur' : 'Valeur extraite'}
          placeholderTextColor={colors.onSurfaceVariant}
          style={[
            typography.bodyMedium,
            styles.input,
            highlighted ? styles.inputHighlighted : null,
          ]}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel={`Champ ${fieldLabelFr(field.field_name)}`}
        />
      )}
      {hint ? <Text style={[typography.labelSmall, styles.inputHint]}>{hint}</Text> : null}
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
  const { user } = useAuth();
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

  const [saving, setSaving] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Tier 5 — start the staged-progress clock at mount so the banner advances
  // Lecture → Analyse while the run is polled (docs/LATENCY-REVIEW.md §5). A scan
  // opened already 'ready' never shows this (see the `ready` render branch below).
  const [mountedAt] = useState(() => Date.now());

  // Guard: the scan was removed from the queue while this screen was open (e.g.
  // validated/discarded from another device sync) — leave silently.
  useEffect(() => {
    if (!scan) navigation.goBack();
  }, [scan, navigation]);

  const gs1 = useMemo(() => parseGs1(barcodeRaw), [barcodeRaw]);
  const fields = run?.fields ?? [];

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

  // GS1 wins on lot/DLC at T+0; the backend reconciles the same way, so the values stay
  // stable once the run lands.
  const lotValue = gs1.lot ?? fields.find((f) => f.field_name === 'batch_number')?.value ?? null;
  const expiryIso = gs1.expiryDate ?? gs1.bestBefore;
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

      await saveBackendArticle({
        ingestion_id: ingestionId,
        extraction_run_id: run.run_id,
        captured_at: ingestion.client_captured_at ?? ingestion.server_received_at,
        tempPhotoUri: photoUri,
        barcode_raw: barcodeRaw ?? null,
        ingestion_status: ingestion.status,
        saved_by: user,
        fields: savedFields,
        raw_extraction_run: run,
      });

      // Cohérence HACCP (audit §4.2): push each human correction to the AUTHORITATIVE
      // backend store (append-only, source='human') so the server holds the validated
      // value, not just this device. Best-effort + non-blocking: the local save is done,
      // so a sync hiccup never stalls the continuous-capture loop. Workflow v1: ALL 17
      // fields are editable, including GS1-owned ones — submitFieldOverrides tags those
      // with force_gs1 so the server accepts them under its dedicated audit action.
      const corrections = savedFields
        .filter((f) => f.edited)
        .map((f) => ({ field_name: f.field_name, value: f.value }));
      // Best-effort backend sync, SEQUENCED: corrections first, THEN the confirm
      // (the confirmed status asserts "review done" — it must never race ahead of
      // the corrections it validates), then a drain to replay any stragglers from
      // previous saves. Fire-and-forget as a whole: the local save is already done,
      // so a sync hiccup never stalls the continuous-capture loop.
      void (async () => {
        if (corrections.length > 0) {
          await submitFieldOverrides({ ingestionId, fields: corrections });
        }
        await enqueueConfirmIngestion({ ingestion_id: ingestionId });
        await drainOutbox();
      })();

      // The scan's job is done: leave the queue (drops the pending/ photo copy too —
      // saveBackendArticle already made its own permanent copy above).
      await completeScan(scan.id);

      // Satisfying confirmation the arrivage was saved (light success haptic, non-blocking).
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Review opens from the home screen now — a successful save simply returns there.
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('ArticleList');
      }
    } catch (err) {
      console.error('Save error:', err);
      Alert.alert(
        "Échec de l\u2019enregistrement",
        "Impossible d\u2019enregistrer l\u2019article. Vérifiez l\u2019espace disponible.",
        [{ text: 'OK' }]
      );
    } finally {
      setSaving(false);
    }
  }, [run, ingestion, ingestionId, scan, photoUri, barcodeRaw, edits, user, navigation]);

  const canSave = ready && run != null && ingestion != null;

  return (
    <View style={styles.root}>
      {photoUri ? (
          <View style={styles.photoContainer}>
            <Pressable
              onPress={() => setViewerOpen(true)}
              style={styles.photoCard}
              accessibilityRole="button"
              accessibilityLabel="Voir la photo en plein écran"
            >
              <Image source={{ uri: photoUri }} style={styles.photo} resizeMode="cover" />
              <View style={styles.expandHint}>
                <MaterialCommunityIcons name="arrow-expand" size={16} color={colors.onPrimary} />
              </View>
            </Pressable>
            <View style={[styles.photoAppBar, { paddingTop: insets.top + 8 }]}>
              <Pressable
                onPress={handleBack}
                hitSlop={12}
                android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
              >
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.onPrimary} />
              </Pressable>
              <Text style={[typography.titleLarge, { color: colors.onPrimary }]}>Vérification</Text>
              <View style={{ width: 24 }} />
            </View>
          </View>
        ) : null}
      <PhotoViewerModal visible={viewerOpen} photoUri={photoUri} onClose={() => setViewerOpen(false)} />

        <ScrollView
          style={styles.contentCard}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <View style={styles.metaRow}>
            <MaterialCommunityIcons name="identifier" size={14} color={colors.onSurfaceVariant} />
            <Text style={[typography.labelSmall, styles.metaText]}>
              Lot : {lotValue ?? '—'}
            </Text>
          </View>
          {expiryIso ? (
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="calendar-alert" size={14} color={colors.onSurfaceVariant} />
              <Text style={[typography.labelSmall, styles.metaText]}>DLC : {displayDate(expiryIso)}</Text>
            </View>
          ) : null}
          {gs1.netWeightKg != null ? (
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="weight-kilogram" size={14} color={colors.onSurfaceVariant} />
              <Text style={[typography.labelSmall, styles.metaText]}>
                Poids : {formatGs1WeightKg(gs1.netWeightKg)}
              </Text>
            </View>
          ) : null}
          {capturedAt ? (
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="calendar-outline" size={14} color={colors.onSurfaceVariant} />
              <Text style={[typography.labelSmall, styles.metaText]}>
                {formatDate(capturedAt)}
              </Text>
            </View>
          ) : null}
          {user ? (
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="account-outline" size={14} color={colors.onSurfaceVariant} />
              <Text style={[typography.labelSmall, styles.metaText]}>{user}</Text>
            </View>
          ) : null}
          <View style={styles.metaRow}>
            <MaterialCommunityIcons name="cloud-check-outline" size={14} color={colors.onSurfaceVariant} />
            <Text style={[typography.labelSmall, styles.metaText]}>
              Statut : {ingestion ? ingestionStatusFr(ingestion.status) : 'Analyse en cours…'}
            </Text>
          </View>
          {barcodeRaw ? (
            <View style={styles.barcodeRow}>
              <MaterialCommunityIcons name="barcode" size={14} color={colors.onSurfaceVariant} />
              <Text style={[typography.labelSmall, styles.metaText]}>{barcodeRaw}</Text>
            </View>
          ) : null}

          <View style={styles.divider} />

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
            // loading OR (ready with fields): a STABLE list in FIELD_ORDER. GS1 rows are
            // filled at T+0, the rest skeleton IN PLACE, then swap to editable when the run
            // lands — same rows, order and heights → zero layout shift (audit §2.1/2.2).
            <>
              {ready ? (
                <Text style={[typography.labelMedium, styles.sectionLabel]}>
                  {`Champs (${fields.length})`}
                </Text>
              ) : (
                <ExtractionProgress startedAt={mountedAt} ready={false} ocrDone={ocrDone} />
              )}
              {FIELD_ORDER.map((name, rowIndex) => {
                const field = fields.find((f) => f.field_name === name);
                if (field) {
                  const row = (
                    <EditableFieldRow
                      key={name}
                      field={field}
                      draft={
                        edits[name] ??
                        (isDateField(name) ? displayDate(field.value ?? '') : field.value ?? '')
                      }
                      onChange={handleFieldChange}
                      highlighted={needsReview(field)}
                      suggestion={name === 'allergens' ? allergenSuggestion : undefined}
                    />
                  );
                  // Wave 3 sweep: only rows that were STILL skeletons animate in — a value
                  // already visible (GS1 / wave-2 preview) swaps silently, never re-flashes.
                  return pendingValues[name] == null ? (
                    <CascadeReveal key={name} delay={cascadeDelay(rowIndex)}>
                      {row}
                    </CascadeReveal>
                  ) : (
                    <View key={name}>{row}</View>
                  );
                }
                return (
                  <PendingFieldRow
                    key={name}
                    fieldName={name}
                    gs1Value={pendingValues[name]}
                    revealDelay={cascadeDelay(rowIndex)}
                  />
                );
              })}
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
                : !ready
                  ? 'Analyse en cours…'
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
  photoContainer: {
    height: 260,
    position: 'relative',
    backgroundColor: colors.onSurface,
  },
  // §6.3 — rounded cover card. The rognage this implies is safe now: a tap always
  // opens PhotoViewerModal at full resolution (`contain`), so nothing is ever lost,
  // only initially cropped for a tidy thumbnail.
  photoCard: {
    ...StyleSheet.absoluteFillObject,
    margin: spacing.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  photo: {
    width: '100%',
    height: '100%',
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
    ...elevation[2],
  },
  contentInner: {
    padding: spacing.lg,
    paddingBottom: spacing['2xl'],
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  barcodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  metaText: {
    color: colors.onSurfaceVariant,
    marginLeft: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.outlineVariant,
    marginVertical: spacing.md,
  },
  sectionLabel: {
    color: colors.onSurfaceVariant,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  ocrCard: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
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
  // Attention reason tag — neutral tint (no red), subtle highlight for weak fields.
  attentionTag: {
    color: colors.onSecondaryContainer,
    backgroundColor: colors.secondaryContainer,
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
  inputHighlighted: {
    backgroundColor: colors.secondaryContainer,
    borderColor: colors.secondary,
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
    backgroundColor: colors.secondaryContainer,
    borderColor: colors.secondary,
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
