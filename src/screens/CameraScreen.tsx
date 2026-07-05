/**
 * CameraScreen — Live viewfinder, barcode detect, chained capture (workflow v1).
 *
 * Flow: aim → tap shutter → the photo is cropped and enqueued in the SCAN QUEUE
 * (background submit + extraction) → the operator keeps shooting immediately, no
 * modal, no wait. The on-screen frame is BOTH the placement guide AND the crop
 * region applied before the photo is enqueued (with a safe fallback to the full
 * image if the frame can't be mapped).
 *
 * The frame is sized to ≈the whole useful zone so the ENTIRE label fits inside, and
 * computeFrameCrop expands the crop by a small safety margin — together these keep
 * label content that used to overflow a small frame from being cropped away.
 *
 * Review/validation moved OFF this screen entirely: the home screen's "En cours"
 * section (PendingScanCard/ScanStepper) is where each queued scan is tracked and
 * opened once ready. This screen stays a pure viewfinder — the ScanTray only shows
 * a thumbnail stack + count, never an error (errors surface on the home screen).
 *
 * Extraction is backend-only — the legacy on-device OCR path was removed for
 * security (audit §7.3); this screen no longer has an opt-out branch.
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
  Dimensions,
  Pressable,
} from 'react-native';
import { StatusBar } from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import { CaptureButton } from '../components/CaptureButton';
import { FrameOverlay, FrameState } from '../components/FrameOverlay';
import { FlashOverlay, FlashOverlayRef } from '../components/FlashOverlay';
import { ScanTray } from '../components/ScanTray';
import { enqueueScan } from '../services/scanQueue';
import { persistPendingPhoto, deletePendingPhoto } from '../services/storage';
import { logLatency } from '../services/latencyLog';
import { colors, spacing, typography } from '../theme';
import { RootStackParamList } from '../navigation/RootNavigator';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

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

export function CameraScreen() {
  const navigation = useNavigation<NavProp>();
  // Mount the live preview only while this screen is focused (freed whenever another
  // screen sits on top; released for good once popped back to Articles).
  const isFocused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [frameState, setFrameState] = useState<FrameState>('ready');
  const [taking, setTaking] = useState(false);
  const [flashMode, setFlashMode] = useState<'off' | 'on' | 'auto'>('off');

  const cameraRef = useRef<CameraView>(null);
  const flashRef = useRef<FlashOverlayRef>(null);
  const lastBarcodeRef = useRef<BarcodeScanningResult | null>(null);
  const mountedRef = useRef(true);

  // ── Permission guard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission, requestPermission]);

  // ── Mark unmounted so a still-running capture doesn't touch state after teardown ──
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Reset the barcode hint when the live viewfinder regains focus ─────────
  useEffect(() => {
    if (isFocused) {
      lastBarcodeRef.current = null;
      setFrameState('ready');
    }
  }, [isFocused]);

  // ── Take a photo and enqueue it — TERMINAL: the operator keeps shooting ────
  const takePhoto = useCallback(async () => {
    // `taking` is the ONLY lock: N scans in flight is the point of the chained
    // workflow, so nothing here waits on the previous submit or extraction.
    if (!cameraRef.current || taking) return;
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

      // Durable copy FIRST, before anything else touches the file. expo-camera's raw
      // capture lives in an OS-managed Caches subdirectory that is NOT guaranteed to
      // survive — under rapid chained capture it can vanish mid-crop (observed on
      // device: NSCocoaErrorDomain 260 "no such file" reading the Camera/ cache file
      // at UPLOAD time, well after capture). Crop from OUR OWN durable copy so a slow
      // crop, or a slow enqueue, never races a source the OS can reclaim at any time.
      const scanId = uuidv4();
      const durableRawUri = await persistPendingPhoto(`${scanId}-raw`, photo.uri);
      if (!durableRawUri) {
        // Could not even secure a durable copy — nothing safe to submit this shot.
        throw new Error('Could not persist the captured photo');
      }

      // ALWAYS produce a downscaled JPEG for upload + Vision OCR, and apply the frame crop
      // WHEN available. Decoupling the resize from the crop is deliberate: a crop failure
      // (orientation mismatch → computeFrameCrop null, or a manipulate throw) must NOT ship a
      // full-size image to Vision. Cap the LONG edge at ~1600px + compress 0.8 (Tier 7 —
      // docs/LATENCY-REVIEW.md §0; OCR is co-dominant on a slow egress, and `cropped=false`
      // was silently defeating the resize).
      let croppedUri: string | undefined;
      let framed = false;
      const crop = computeFrameCrop(photo.width, photo.height);
      if (!crop) {
        // Why `framed=false` happens — almost always an orientation mismatch between the
        // photo buffer and the portrait preview. Dev-only diagnostic (dimensions only).
        logLatency('frame_crop_skipped', {
          photo: `${photo.width}x${photo.height}`,
          screen: `${Math.round(SCREEN_WIDTH)}x${Math.round(SCREEN_HEIGHT)}`,
        });
      }
      const srcW = crop ? crop.width : photo.width;
      const srcH = crop ? crop.height : photo.height;
      // Cap the LONGER side so portrait OR landscape buffers both shrink.
      const resize =
        srcW >= srcH ? { width: Math.min(srcW, 1600) } : { height: Math.min(srcH, 1600) };
      try {
        const out = await ImageManipulator.manipulateAsync(
          durableRawUri,
          crop ? [{ crop }, { resize }] : [{ resize }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        croppedUri = out.uri;
        framed = crop != null;
      } catch (e) {
        console.warn('Immediate crop/resize failed; durable raw copy will be used:', e);
      }

      const capturedAt = new Date().toISOString();
      const barcodeRaw = lastBarcodeRef.current?.data;

      // Enqueue and move on — the scan queue owns submit + extraction from here.
      // Never throws; a submit failure surfaces as a 'submit_error' card at home.
      void enqueueScan({
        id: scanId,
        tempUri: croppedUri ?? durableRawUri,
        barcodeRaw,
        capturedAt,
      }).then((scan) => {
        logLatency('capture', { framed: String(framed) });
        // Clean up the raw intermediate — UNLESS enqueueScan's own persist failed and
        // fell back to this exact uri (then it's the scan's only copy; keep it).
        if (scan.photoUri !== durableRawUri) void deletePendingPhoto(durableRawUri);
      });

      lastBarcodeRef.current = null;
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
  }, [taking]);

  // ── Barcode detected — store for the next capture, no auto-shoot ───────────
  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (taking) return;
      lastBarcodeRef.current = result;
      setFrameState('barcodeFound');
    },
    [taking]
  );

  const toggleFlash = useCallback(() => {
    setFlashMode((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'));
  }, []);

  // ── Leave the capture module → back to Articles (pops Camera → unmounts it) ──
  const closeCapture = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('ArticleList');
    }
  }, [navigation]);

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
          onBarcodeScanned={taking ? undefined : handleBarcodeScanned}
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

      {/* Bottom control tray — left slot is the scan tray (workflow v1): thumbnail
          stack + count of scans currently submitting/extracting, tap → home. */}
      <View style={styles.bottomTray}>
        <View style={styles.traySlot}>
          <ScanTray onPress={closeCapture} />
        </View>
        <CaptureButton onPress={takePhoto} loading={taking} disabled={taking} />
        <View style={styles.traySlot} />
      </View>

      {/* Flash white overlay */}
      <FlashOverlay ref={flashRef} />
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
    alignItems: 'center',
    justifyContent: 'center',
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
