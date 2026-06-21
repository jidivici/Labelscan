/**
 * CameraScreen — Live viewfinder, barcode detect, manual capture, photo review.
 *
 * Flow: aim → tap shutter to TAKE a photo → REVIEW it (retake or validate) →
 * only on "Valider" is the image sent for extraction. Capture is manual only
 * (no auto-capture); the on-screen frame is BOTH the placement guide AND the crop
 * region — on validate the captured photo is cropped to the frame before it is
 * sent (with a safe fallback to the full image if the frame can't be mapped).
 *
 * The frame is sized to ≈the whole useful zone so the ENTIRE label fits inside, and
 * computeFrameCrop expands the crop by a small safety margin — together these keep
 * label content that used to overflow a small frame from being cropped away.
 *
 * Capture module / loop: this screen is pushed from the Articles FAB and popped when
 * the operator leaves (top-left back control → Articles). The live preview mounts
 * only while focused (freed whenever Review sits on top, fully released on pop). On
 * "Valider", Review saves then pops back here so the operator can shoot the next
 * label without re-opening the camera (rapid continuous capture).
 *
 * Two extraction paths, selected by BACKEND_FIRST (default: backend):
 *  - backend: crop to frame → POST /v1/ingestions → poll status → fetch run → Review.
 *  - legacy (EXPO_PUBLIC_BACKEND_FIRST=false): crop below the frame → on-device OCR
 *    via Cloud Vision → Review (display only; saving requires backend mode).
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Dimensions,
  Pressable,
  Alert,
} from 'react-native';
import { StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';

import { CaptureButton } from '../components/CaptureButton';
import { FrameOverlay, FrameState } from '../components/FrameOverlay';
import { ProcessingOverlay } from '../components/ProcessingOverlay';
import { FlashOverlay, FlashOverlayRef } from '../components/FlashOverlay';
import { extractTextFromImage } from '../services/ocr';
import { submitCapture } from '../services/ingestionSubmit';
import { BACKEND_FIRST } from '../config';
import { colors, spacing, radius, typography } from '../theme';
import { RootStackParamList } from '../navigation/RootNavigator';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Legacy on-device OCR crop region (used ONLY when BACKEND_FIRST=false). Unchanged.
const ZONE_WIDTH = SCREEN_WIDTH * 0.8;
const ZONE_HEIGHT = 72;
const ZONE_LEFT = (SCREEN_WIDTH - ZONE_WIDTH) / 2;
const ZONE_TOP = SCREEN_HEIGHT * 0.52;

// Label-placement frame — both the VISUAL GUIDE and the crop region. The full
// photo is captured, then cropped to this rectangle before submit (see
// computeFrameCrop). The frame is sized to ≈100% of the useful zone (the whole band
// between the top bar and the bottom tray) so the operator can place the ENTIRE
// label inside — earlier the frame was a small landscape rectangle and labels that
// overflowed it were cropped away, losing OCR content (the regression we fix here).
const TOP_BAR_H = 90;
const BOTTOM_TRAY_H = 120;
// Reserve a little room below the frame for the instruction caption.
const CAPTION_RESERVE = 44;
const FRAME_LEFT = SCREEN_WIDTH * 0.02; // ~96% of the width
const FRAME_WIDTH = SCREEN_WIDTH - FRAME_LEFT * 2;
const FRAME_TOP = TOP_BAR_H + 12;
const FRAME_HEIGHT =
  SCREEN_HEIGHT - FRAME_TOP - BOTTOM_TRAY_H - CAPTION_RESERVE;

// Safety margin: expand the mapped crop a touch beyond the frame on every side so a
// label resting right against the brackets is not clipped at the edges. Clamped to
// the photo bounds in computeFrameCrop, so it can never read out-of-bounds pixels.
const CROP_SAFETY_MARGIN = 0.08; // 8% of the frame's width/height per axis

/**
 * Map the on-screen placement frame to a crop rectangle in the captured photo's own
 * pixel space, so the submitted photo is EXACTLY what the user framed. The preview
 * fills the screen edge-to-edge with a "cover" fit (the image is scaled up until it
 * covers the screen, then centered and the overflow clipped); we invert that
 * transform to find the photo pixels under the frame.
 *
 * This requires the captured photo to be UPRIGHT — i.e. its orientation matches the
 * portrait preview (guaranteed by takePictureAsync's skipProcessing:false, which
 * applies sensor rotation). As a safety net, if the buffer still comes back
 * TRANSPOSED (portrait-vs-landscape mismatch — we then can't know the rotation
 * direction), or if the mapped rect is degenerate, we return null and the caller
 * sends the full image rather than crop the wrong region (no data loss).
 */
function computeFrameCrop(
  photoWidth: number,
  photoHeight: number,
): { originX: number; originY: number; width: number; height: number } | null {
  if (!photoWidth || !photoHeight) return null;

  // Orientation guard: photo and screen must share orientation for this mapping.
  if (SCREEN_WIDTH > SCREEN_HEIGHT !== photoWidth > photoHeight) return null;

  // Cover fit: one scale factor; the larger axis ratio wins so the photo covers
  // the whole screen. The centered overflow is the offset we subtract back out.
  const scale = Math.max(SCREEN_WIDTH / photoWidth, SCREEN_HEIGHT / photoHeight);
  const offsetX = (photoWidth * scale - SCREEN_WIDTH) / 2;
  const offsetY = (photoHeight * scale - SCREEN_HEIGHT) / 2;

  // Expand the frame rect (in screen space) by the safety margin on every side
  // before inverting the transform, so edges near the brackets aren't clipped.
  const marginX = FRAME_WIDTH * CROP_SAFETY_MARGIN;
  const marginY = FRAME_HEIGHT * CROP_SAFETY_MARGIN;
  const frameLeft = FRAME_LEFT - marginX;
  const frameTop = FRAME_TOP - marginY;
  const frameWidth = FRAME_WIDTH + marginX * 2;
  const frameHeight = FRAME_HEIGHT + marginY * 2;

  let originX = (frameLeft + offsetX) / scale;
  let originY = (frameTop + offsetY) / scale;
  let width = frameWidth / scale;
  let height = frameHeight / scale;

  // Clamp into the photo so we never ask the manipulator for out-of-bounds pixels.
  originX = Math.max(0, Math.min(originX, photoWidth));
  originY = Math.max(0, Math.min(originY, photoHeight));
  width = Math.min(width, photoWidth - originX);
  height = Math.min(height, photoHeight - originY);

  if (width < 1 || height < 1) return null;

  return {
    originX: Math.floor(originX),
    originY: Math.floor(originY),
    width: Math.floor(width),
    height: Math.floor(height),
  };
}

type NavProp = StackNavigationProp<RootStackParamList, 'Camera'>;

/** A photo taken but not yet sent for extraction (awaiting user validation). */
interface PendingPhoto {
  uri: string;
  width: number;
  height: number;
  croppedUri?: string;
  barcodeRaw?: string;
  capturedAt: string;
}

export function CameraScreen() {
  const navigation = useNavigation<NavProp>();
  const insets = useSafeAreaInsets();
  // Mount the live preview only while this screen is focused. While Review (modal)
  // sits on top, the preview unmounts — freeing the single camera resource — and
  // remounts when we pop back to continue the capture loop. Once popped off the
  // stack entirely (back to Articles) the screen unmounts, releasing it for good.
  const isFocused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [frameState, setFrameState] = useState<FrameState>('ready');
  const [taking, setTaking] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [pending, setPending] = useState<PendingPhoto | null>(null);
  const [flashMode, setFlashMode] = useState<'off' | 'on' | 'auto'>('off');

  const cameraRef = useRef<CameraView>(null);
  const flashRef = useRef<FlashOverlayRef>(null);
  const lastBarcodeRef = useRef<BarcodeScanningResult | null>(null);
  const mountedRef = useRef(true);
  const submitInFlightRef = useRef(false);

  // ── Permission guard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission, requestPermission]);

  // ── Mark unmounted so an in-flight submit doesn't navigate after teardown ──
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Reset transient state for a clean next capture when the live viewfinder
  //    regains focus (e.g. after a save pops Review off the top). ─────────────
  useEffect(() => {
    if (isFocused) {
      setPending(null);
      lastBarcodeRef.current = null;
      setFrameState('ready');
    }
  }, [isFocused]);

  // ── Take a photo (manual shutter) — does NOT submit; opens the review step ──
  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || taking || processing || pending) return;
    setTaking(true);
    setFrameState('capturing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    flashRef.current?.trigger();
    try {
      const photo = await cameraRef.current.takePictureAsync({
        // Max fidelity so small print on the label OCRs well (no source-side
        // recompression beyond the single capture encode).
        quality: 1.0,
        // Apply sensor rotation (do NOT skip processing) so width/height describe the
        // UPRIGHT image matching the portrait preview. skipProcessing:true returned an
        // unrotated buffer on Android, which made computeFrameCrop crop the wrong region.
        skipProcessing: false,
      });
      if (!photo) throw new Error('Photo capture failed');
      if (!mountedRef.current) return;

      let croppedUri: string | undefined;
      if (BACKEND_FIRST) {
        const crop = computeFrameCrop(photo.width, photo.height);
        if (crop) {
          try {
            // Crop only — no resize. compress:1.0 keeps the second JPEG encode
            // lossless-ish so the cropped image preserves small-print legibility.
            const cropped = await ImageManipulator.manipulateAsync(
              photo.uri,
              [{ crop }],
              { compress: 1.0, format: ImageManipulator.SaveFormat.JPEG }
            );
            croppedUri = cropped.uri;
          } catch (e) {
            console.warn('Immediate frame crop failed; full image will be used:', e);
          }
        }
      }

      setPending({
        uri: photo.uri,
        width: photo.width,
        height: photo.height,
        croppedUri,
        barcodeRaw: lastBarcodeRef.current?.data,
        capturedAt: new Date().toISOString(),
      });
      setFrameState('ready');
    } catch (err) {
      console.error('Capture error:', err);
      if (mountedRef.current) {
        setFrameState('error');
        setTimeout(() => {
          if (mountedRef.current) setFrameState('ready');
        }, 2500);
      }
    } finally {
      if (mountedRef.current) setTaking(false);
    }
  }, [taking, processing, pending]);

  // ── Retake: discard the pending photo, back to the live viewfinder ─────────
  const retake = useCallback(() => {
    setPending(null);
    lastBarcodeRef.current = null;
    setFrameState('ready');
  }, []);

  // ── Validate: send the reviewed photo for extraction ──────────────────────
  const confirmAndSubmit = useCallback(async () => {
    if (!pending || processing || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setProcessing(true);

    try {
      // backend_first: use the already-cropped frame photo (cropped on capture),
      // fallback to the full image if immediate crop failed.
      if (BACKEND_FIRST) {
        let submitUri = pending.croppedUri ?? pending.uri;
        const outcome = await submitCapture({
          fileUri: submitUri,
          barcodeRaw: pending.barcodeRaw,
          capturedAt: pending.capturedAt,
        });
        if (outcome.kind === 'succeeded') {
          // Cascade: do NOT block on extraction here. The upload is the only thing the
          // operator waited for — hand off to Review immediately. Review decodes the GS1
          // barcode for the T+0 fields (lot, DLC) and polls the OCR/LLM result itself
          // (useIngestionResult), filling the rest in place. This replaces the old
          // full-screen spinner that froze the UI for the whole server round-trip.
          if (!mountedRef.current) return;
          setPending(null);
          navigation.push('Review', {
            mode: 'backend',
            ingestionId: outcome.ingestionId,
            photoUri: submitUri, // the cropped image actually sent for extraction
            barcodeRaw: pending.barcodeRaw,
            capturedAt: pending.capturedAt,
          });
          return;
        } else {
          // Backend submit failure: never reached the server, or was rejected.
          console.warn('Ingestion submission incomplete:', outcome);
          let title = 'Échec de l’envoi';
          let message = 'Le serveur a rejeté cette capture. Reprenez la photo et réessayez.';
          if (outcome.kind === 'pending') {
            title = 'Enregistré localement';
            message = 'Enregistré localement mais non envoyé. La nouvelle tentative automatique n’est pas encore disponible.';
          } else if (outcome.code === 'CONFIG_ERROR') {
            title = 'Non configuré';
            message = 'L’application n’est pas configurée pour joindre le serveur. Contactez le développeur.';
          } else if (outcome.code === 'UNAUTHENTICATED' || outcome.code === 'FORBIDDEN') {
            title = 'Connexion requise';
            message = 'Votre session a peut-être expiré. Reconnectez-vous et réessayez.';
          }
          Alert.alert(title, message);
        }
        return; // backend_first path complete (finally still runs)
      }

      // Legacy on-device OCR: crop the fixed zone (screen proportions mapped to the
      // photo resolution), then OCR it — same crop math as before.
      const scaleX = pending.width / SCREEN_WIDTH;
      const scaleY = pending.height / SCREEN_HEIGHT;
      const cropped = await ImageManipulator.manipulateAsync(
        pending.uri,
        [
          {
            crop: {
              originX: Math.floor(ZONE_LEFT * scaleX),
              originY: Math.floor(ZONE_TOP * scaleY),
              width: Math.floor(ZONE_WIDTH * scaleX),
              height: Math.floor(ZONE_HEIGHT * scaleY * 2.5),
            },
          },
        ],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      const ocrText = await extractTextFromImage(cropped.uri);
      if (!mountedRef.current) return;
      setPending(null);
      navigation.push('Review', {
        photoUri: pending.uri,
        ocrText,
        barcodeValue: pending.barcodeRaw,
        capturedAt: pending.capturedAt,
      });
    } catch (err) {
      console.error('Submit/OCR error:', err);
      if (mountedRef.current) {
        Alert.alert('Échec de l’envoi', 'Une erreur est survenue. Reprenez la photo et réessayez.');
      }
    } finally {
      submitInFlightRef.current = false;
      if (mountedRef.current) setProcessing(false);
    }
  }, [pending, processing, navigation]);

  // ── Barcode detected — store for the next capture, no auto-shoot ───────────
  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (processing || taking || pending) return;
      lastBarcodeRef.current = result;
      setFrameState('barcodeFound');
    },
    [processing, taking, pending]
  );

  const toggleFlash = useCallback(() => {
    setFlashMode((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'));
  }, []);

  // ── Leave the capture module → back to Articles (pops Camera → unmounts it) ──
  const closeCapture = useCallback(() => {
    if (processing) return; // don't abandon an in-flight submit
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('ArticleList');
    }
  }, [navigation, processing]);

  const flashIcon =
    flashMode === 'off'
      ? 'flash-off'
      : flashMode === 'on'
      ? 'flash'
      : 'flash-auto';

  // ── No permission ─────────────────────────────────────────────────────────
  if (!permission?.granted) {
    return (
      <View style={styles.permissionContainer}>
        <MaterialCommunityIcons
          name="camera-off"
          size={48}
          color={colors.onSurfaceVariant}
        />
        <Text style={[typography.titleMedium, styles.permissionTitle]}>
          Accès à la caméra requis
        </Text>
        <Pressable
          onPress={requestPermission}
          style={styles.permissionButton}
          android_ripple={{ color: colors.primaryContainer }}
          accessibilityRole="button"
          accessibilityLabel="Autoriser l’accès à la caméra"
        >
          <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
            Autoriser l’accès
          </Text>
        </Pressable>
        {/* Always offer a way back to Articles (this is a pushed screen now). */}
        <Pressable
          onPress={closeCapture}
          style={styles.permissionBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Revenir aux articles"
        >
          <Text style={[typography.labelLarge, { color: colors.primary }]}>
            Retour aux articles
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Camera preview — edge to edge. Mounted only while focused so the single
          camera resource is freed whenever we leave the live viewfinder. */}
      {isFocused ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          flash={flashMode}
          onBarcodeScanned={processing || taking || pending ? undefined : handleBarcodeScanned}
          barcodeScannerSettings={{
            barcodeTypes: [
              'ean13', 'ean8', 'upc_a', 'upc_e',
              'code128', 'code39', 'qr',
            ],
          }}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
      )}

      {/* Label-placement frame (placement guide + crop region applied on validate) */}
      <FrameOverlay
        state={frameState}
        frameTop={FRAME_TOP}
        frameLeft={FRAME_LEFT}
        frameWidth={FRAME_WIDTH}
        frameHeight={FRAME_HEIGHT}
      />

      {/* Top overlay bar */}
      <View style={styles.topBar}>
        <Pressable
          onPress={closeCapture}
          style={styles.topBarBack}
          hitSlop={8}
          disabled={processing}
          accessibilityRole="button"
          accessibilityLabel="Revenir aux articles"
        >
          <MaterialCommunityIcons name="arrow-left" size={24} color={colors.onPrimary} />
        </Pressable>
        <Text style={[typography.titleLarge, styles.topBarTitle]}>
          Scan Label
        </Text>
        <Pressable
          onPress={toggleFlash}
          style={styles.topBarAction}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Basculer le flash"
        >
          <MaterialCommunityIcons name={flashIcon} size={24} color={colors.onPrimary} />
        </Pressable>
      </View>

      {/* Bottom control tray */}
      <View style={styles.bottomTray}>
        <View style={styles.traySlot} />
        <CaptureButton
          onPress={takePhoto}
          loading={taking}
          disabled={taking || processing}
        />
        <View style={styles.traySlot} />
      </View>

      {/* Flash white overlay */}
      <FlashOverlay ref={flashRef} />

      {/* Photo review step (take → VALIDATE → extract) */}
      {pending ? (
        <View style={styles.previewRoot}>
          <Image source={{ uri: pending.croppedUri ?? pending.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          <View style={[styles.previewHeader, { paddingTop: insets.top + spacing.md }]}>
            <Text style={[typography.titleMedium, styles.previewTitle]}>Vérifiez la photo</Text>
            <Text style={[typography.bodySmall, styles.previewSubtitle]}>
              L’étiquette est-elle nette et entièrement visible ?
            </Text>
          </View>
          <View style={[styles.previewActions, { paddingBottom: insets.bottom + spacing.lg }]}>
            <Pressable
              onPress={retake}
              disabled={processing}
              style={styles.retakeButton}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel="Reprendre la photo"
            >
              <MaterialCommunityIcons
                name="camera-retake-outline"
                size={18}
                color={colors.onPrimary}
                style={{ marginRight: spacing.xs }}
              />
              <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>Reprendre</Text>
            </Pressable>
            <Pressable
              onPress={confirmAndSubmit}
              disabled={processing}
              style={styles.validateButton}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel="Valider la photo et lancer l’extraction"
            >
              <MaterialCommunityIcons
                name="check"
                size={18}
                color={colors.onPrimary}
                style={{ marginRight: spacing.xs }}
              />
              <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>Valider</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Upload overlay only. In backend mode the extraction itself is NOT awaited
          here — it runs on the Review screen (GS1 at T+0 + progressive fill). */}
      <ProcessingOverlay
        visible={processing}
        message={BACKEND_FIRST ? 'Envoi de la photo…' : 'Lecture du texte…'}
        subtitle={
          BACKEND_FIRST
            ? 'Téléversement en cours'
            : 'Cela prend généralement 1 à 2 secondes'
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 90,
    paddingTop: 44, // status bar safe area
    backgroundColor: 'rgba(0,0,0,0.40)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  topBarTitle: {
    color: colors.onPrimary,
    flex: 1,
    textAlign: 'center',
  },
  topBarBack: {
    position: 'absolute',
    left: spacing.lg,
    bottom: 12,
  },
  topBarAction: {
    position: 'absolute',
    right: spacing.lg,
    bottom: 12,
  },
  bottomTray: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
    paddingBottom: 24,
    backgroundColor: 'rgba(0,0,0,0.50)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: spacing.xl,
  },
  traySlot: {
    width: 48,
    height: 48,
  },
  // ── Photo review overlay ──
  previewRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  previewHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  previewTitle: {
    color: colors.onPrimary,
    textAlign: 'center',
  },
  previewSubtitle: {
    color: colors.onPrimary,
    opacity: 0.85,
    textAlign: 'center',
    marginTop: 2,
  },
  previewActions: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  retakeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.onPrimary,
  },
  validateButton: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  permissionTitle: {
    color: colors.onSurface,
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 24,
    marginTop: spacing.sm,
  },
  permissionBack: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
});
