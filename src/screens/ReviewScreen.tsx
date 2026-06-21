/**
 * ReviewScreen — dual mode.
 *  - Legacy (backend_first=false): on-device OCR result, display only. Save is
 *    disabled — there is no on-device Article model; saving requires backend mode.
 *  - Backend (backend_first=true):  display the server extraction result (status +
 *    per-field value/confidence/validation_status) and Save a backend Article
 *    (structured fields preserved) via saveBackendArticle.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Pressable,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { saveBackendArticle } from '../services/storage';
import { suggestAllergen } from '../services/allergenSuggestions';
import { submitFieldOverrides, isHumanEditableField } from '../services/fieldOverrideSubmit';
import {
  maskDate,
  isDateField,
  displayDate,
  parseWeight,
  formatWeight,
  parseTemp,
  formatTemp,
  type WeightUnit,
} from '../services/inputMasks';
import { fieldLabelFr, ingestionStatusFr } from '../services/fieldLabels';
import { parseGs1, formatGs1WeightKg } from '../services/gs1';
import { useIngestionResult } from '../hooks/useIngestionResult';
import { SkeletonFieldList } from '../components/SkeletonFieldList';
import { formatDate } from '../services/dates';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, radius, typography, elevation } from '../theme';
import type {
  BackendReviewParams,
  CaptureStackParamList,
  LegacyReviewParams,
} from '../navigation/RootNavigator';
import type { ExtractionField } from '../types/api';
import type { ArticleField } from '../types/Article';

type RouteType = RouteProp<CaptureStackParamList, 'Review'>;
type NavProp = StackNavigationProp<CaptureStackParamList, 'Review'>;

// ── Dispatcher: pick the mode from the (discriminated) route params ──────────────

export function ReviewScreen() {
  const route = useRoute<RouteType>();
  if (route.params.mode === 'backend') {
    return <BackendReview params={route.params} />;
  }
  return <LegacyReview params={route.params} />;
}

// ── Legacy (on-device OCR) — behavior unchanged ──────────────────────────────────

function LegacyReview({ params }: { params: LegacyReviewParams }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavProp>();
  const { photoUri, ocrText, barcodeValue, capturedAt } = params;

  const handleRetake = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // The local Article model is backend-extraction only — on-device OCR results
  // are not persisted. Save is disabled here; saving requires backend mode.
  const handleSaveDisabled = useCallback(() => {
    Alert.alert(
      'Enregistrement indisponible',
      'Les résultats OCR sur l’appareil ne sont pas enregistrés. Activez le mode backend pour enregistrer les articles extraits.'
    );
  }, []);

  const hasText = Boolean(ocrText?.trim());

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      {/* Photo */}
      <View style={styles.photoContainer}>
        <Image source={{ uri: photoUri }} style={styles.photo} resizeMode="cover" />
        {/* App bar overlay */}
        <View style={[styles.photoAppBar, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={handleRetake}
            hitSlop={12}
            android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
          >
            <MaterialCommunityIcons name="arrow-left" size={24} color={colors.onPrimary} />
          </Pressable>
          <Text style={[typography.titleLarge, { color: colors.onPrimary }]}>Vérification</Text>
          <View style={{ width: 24 }} />
        </View>
      </View>

      {/* Content card that overlaps photo */}
      <ScrollView
        style={styles.contentCard}
        contentContainerStyle={styles.contentInner}
        showsVerticalScrollIndicator={false}
      >
        {/* Date row */}
        <View style={styles.metaRow}>
          <MaterialCommunityIcons name="calendar-outline" size={14} color={colors.onSurfaceVariant} />
          <Text style={[typography.labelSmall, styles.metaText]}>
            {formatDate(capturedAt)}
          </Text>
        </View>

        {/* Barcode value */}
        {barcodeValue ? (
          <View style={styles.barcodeRow}>
            <MaterialCommunityIcons name="barcode" size={14} color={colors.onSurfaceVariant} />
            <Text style={[typography.labelSmall, styles.metaText]}>{barcodeValue}</Text>
          </View>
        ) : null}

        {/* Divider */}
        <View style={styles.divider} />

        {/* OCR text block */}
        <Text style={[typography.labelMedium, styles.sectionLabel]}>Texte extrait</Text>
        <View style={styles.ocrCard}>
          <Text
            selectable
            style={[
              typography.bodyLarge,
              { color: hasText ? colors.onSurface : colors.onSurfaceVariant },
            ]}
          >
            {hasText ? ocrText : 'Aucun texte extrait — étiquette vide ou illisible.'}
          </Text>
        </View>
      </ScrollView>

      {/* Action row */}
      <View style={[styles.actionRow, { paddingBottom: insets.bottom + spacing.md }]}>
        <Pressable
          onPress={handleRetake}
          style={styles.retakeButton}
          android_ripple={{ color: colors.primaryContainer }}
        >
          <MaterialCommunityIcons
            name="camera-retake-outline"
            size={18}
            color={colors.primary}
            style={{ marginRight: spacing.xs }}
          />
          <Text style={[typography.labelLarge, { color: colors.primary }]}>Reprendre</Text>
        </Pressable>

        <Pressable
          onPress={handleSaveDisabled}
          style={[styles.saveButton, styles.saveButtonDisabled]}
          android_ripple={{ color: colors.primaryContainer }}
        >
          <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>Enregistrer (backend uniquement)</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Backend (server extraction) — single homogeneous editable list ────────────────

// A field "needs attention" only when it is EMPTY (a value to fill in). We deliberately
// do NOT surface AI confidence or an "à vérifier" flag here: manual validation is the
// single source of truth (CLAUDE.md "Clean UI Radicale", audit §6.2). The highlight is
// purely a fill-in affordance, never a quality judgement on an extracted value.
function needsReview(field: ExtractionField): boolean {
  return field.value == null || field.value === '';
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

function EditableFieldRow({
  field,
  draft,
  onChange,
  highlighted,
  suggestion,
}: {
  field: ExtractionField;
  draft: string;
  onChange: (text: string) => void;
  highlighted: boolean;
  suggestion?: string | null;
}) {
  // A suggestion is offered only while the field is still empty; it never overrides a
  // typed/extracted value and is applied only on tap (→ a human edit on save).
  const showSuggestion = !!suggestion && draft.trim() === '';
  // Date fields: number-pad + a DD/MM/YYYY mask (auto "/"). An INPUT helper that
  // formats the digits the operator reads off the label — it never computes a date.
  const isDate = isDateField(field.field_name);
  // Price is amount-dominant (the criée works in EUR); a decimal pad is the right
  // keyboard. A dedicated currency affix is tracked in the item-5 input plan.
  const isPrice = field.field_name === 'price';
  const handleChange = (text: string) => onChange(isDate ? maskDate(text) : text);
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldHeader}>
        <Text style={[typography.labelSmall, styles.fieldName]}>{fieldLabelFr(field.field_name)}</Text>
        {highlighted ? (
          <Text style={[typography.labelSmall, styles.attentionTag]}>À compléter</Text>
        ) : null}
      </View>
      {field.field_name === 'weight' ? (
        <WeightInput draft={draft} onChange={onChange} highlighted={highlighted} />
      ) : field.field_name === 'storage_temperature' ? (
        <TempRangeInput draft={draft} onChange={onChange} highlighted={highlighted} />
      ) : (
        <TextInput
          value={draft}
          onChangeText={handleChange}
          keyboardType={isDate ? 'number-pad' : isPrice ? 'decimal-pad' : 'default'}
          maxLength={isDate ? 10 : undefined}
          placeholder={isDate ? 'JJ/MM/AAAA' : highlighted ? 'Saisir la valeur' : 'Valeur extraite'}
          placeholderTextColor={colors.onSurfaceVariant}
          style={[
            typography.bodyMedium,
            styles.input,
            highlighted ? styles.inputHighlighted : null,
          ]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel={`Champ ${fieldLabelFr(field.field_name)}`}
        />
      )}
      {showSuggestion ? (
        <Pressable
          onPress={() => onChange(suggestion as string)}
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
}

function BackendReview({ params }: { params: BackendReviewParams }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavProp>();
  const { user } = useAuth();
  const { ingestionId, photoUri, barcodeRaw, capturedAt: capturedAtParam } = params;

  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  // T+0 — decode the scanned GS1 barcode locally. This data is exact (it comes from the
  // barcode symbology, not OCR), so lot / DLC / weight appear the instant this screen
  // mounts, before the server extraction returns.
  const gs1 = useMemo(() => parseGs1(barcodeRaw), [barcodeRaw]);
  // The slow half — poll the server extraction (OCR + LLM + reconciliation) in the
  // background and reveal the editable field list once it's ready.
  const { phase, ingestion, run } = useIngestionResult(ingestionId);

  const fields = run?.fields ?? [];

  // Allergen decision-support (chantier B): derive ONE EU-family suggestion from the
  // species/product fields. Pure + returns null when unsure (mixed/empty). It is shown
  // only on the `allergens` row and only while that row is still empty; accepting it
  // records a HUMAN edit (source='human' on save), never an extracted value — the
  // no-fabrication gate is untouched. See services/allergenSuggestions.ts.
  const allergenSuggestion = useMemo(() => suggestAllergen(fields), [fields]);

  // GS1 wins on lot/DLC at T+0; the backend reconciles the same way, so the values stay
  // stable once the run lands.
  const lotValue = gs1.lot ?? fields.find((f) => f.field_name === 'batch_number')?.value ?? null;
  const expiryIso = gs1.expiryDate ?? gs1.bestBefore;
  const capturedAt =
    capturedAtParam ?? ingestion?.client_captured_at ?? ingestion?.server_received_at ?? null;

  const handleRetake = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleSave = useCallback(async () => {
    if (!run || !ingestion) return;
    setSaving(true);
    try {
      const savedFields: ArticleField[] = run.fields.map((f): ArticleField => {
        const draft = edits[f.field_name];
        const hasEdit = draft !== undefined;
        let nextValue = hasEdit ? (draft.trim() === '' ? null : draft.trim()) : f.value;
        const changed = hasEdit && nextValue !== f.value;
        // Mobile presents/stores dates as DD/MM/YYYY; the raw run (raw_extraction_run
        // below) keeps the canonical ISO for provenance + the backend chronological gate.
        if (nextValue != null && isDateField(f.field_name)) {
          nextValue = displayDate(nextValue);
        }
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
      // so a sync hiccup never stalls the continuous-capture loop. GS1-owned fields are
      // skipped (the backend rejects them; they're barcode-exact).
      const corrections = savedFields
        .filter((f) => f.edited && isHumanEditableField(f.field_name))
        .map((f) => ({ field_name: f.field_name, value: f.value }));
      if (corrections.length > 0) {
        void submitFieldOverrides({ ingestionId, fields: corrections });
      }

      // Satisfying confirmation the arrivage was saved (light success haptic, non-blocking).
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Continuous-capture loop: after a successful save, return to the still-mounted
      // Camera (directly beneath this modal) ready for the next label — NOT all the way
      // back to Articles. The Camera screen reset its pending photo before pushing
      // Review, so popping back lands on the live viewfinder. The operator returns to
      // Articles from the camera's own back control. canGoBack() guards the (unexpected)
      // case where Review is the only screen on the stack.
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
  }, [run, ingestion, ingestionId, photoUri, barcodeRaw, edits, user, navigation]);

  const canSave = phase === 'ready' && run != null && ingestion != null;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.root, { paddingBottom: insets.bottom }]}>
        {photoUri ? (
          <View style={styles.photoContainer}>
            <Image source={{ uri: photoUri }} style={styles.photo} resizeMode="contain" />
            <View style={[styles.photoAppBar, { paddingTop: insets.top + 8 }]}>
              <Pressable
                onPress={handleRetake}
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

        <ScrollView
          style={styles.contentCard}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
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

          {phase === 'loading' ? (
            <>
              <Text style={[typography.labelMedium, styles.sectionLabel]}>
                Analyse de l’étiquette…
              </Text>
              <SkeletonFieldList count={6} />
            </>
          ) : phase === 'failed' || phase === 'timeout' || phase === 'error' ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                {phase === 'timeout'
                  ? 'Le serveur traite encore cette étiquette. Patientez un instant, puis reprenez la photo si besoin.'
                  : phase === 'failed'
                    ? 'Le serveur n’a pas pu extraire cette étiquette. Reprenez la photo.'
                    : 'Impossible de joindre le serveur. Vérifiez votre connexion, puis reprenez la photo.'}
              </Text>
            </View>
          ) : run == null ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                Impossible de charger les champs extraits. L'étiquette a été traitée sur le serveur
                (statut : {ingestion ? ingestionStatusFr(ingestion.status) : '—'}).
              </Text>
            </View>
          ) : fields.length === 0 ? (
            <View style={styles.ocrCard}>
              <Text style={[typography.bodyMedium, { color: colors.onSurfaceVariant }]}>
                Aucun champ extrait.
              </Text>
            </View>
          ) : (
            <>
              <Text style={[typography.labelMedium, styles.sectionLabel]}>
                Champs ({fields.length})
              </Text>
              {fields.map((f) => (
                <EditableFieldRow
                  key={f.field_name}
                  field={f}
                  draft={
                    edits[f.field_name] ??
                    (isDateField(f.field_name) ? displayDate(f.value ?? '') : f.value ?? '')
                  }
                  onChange={(text) =>
                    setEdits((prev) => ({ ...prev, [f.field_name]: text }))
                  }
                  highlighted={needsReview(f)}
                  suggestion={f.field_name === 'allergens' ? allergenSuggestion : undefined}
                />
              ))}
            </>
          )}
        </ScrollView>

        <View style={[styles.actionRow, { paddingBottom: insets.bottom + spacing.md }]}>
          <Pressable
            onPress={handleRetake}
            style={styles.retakeButton}
            android_ripple={{ color: colors.primaryContainer }}
          >
            <MaterialCommunityIcons
              name="camera-retake-outline"
              size={18}
              color={colors.primary}
              style={{ marginRight: spacing.xs }}
            />
            <Text style={[typography.labelLarge, { color: colors.primary }]}>Reprendre</Text>
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
                : phase === 'loading'
                  ? 'Analyse en cours…'
                  : 'Enregistrer l’arrivage'}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
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
    // Dark, neutral backdrop: with resizeMode="contain" the letterboxing around the
    // frame-only crop reads as a deliberate frame rather than a rendering gap.
    backgroundColor: colors.onSurface,
  },
  photo: {
    width: '100%',
    height: '100%',
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
