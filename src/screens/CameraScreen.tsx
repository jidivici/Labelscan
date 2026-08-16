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
 * section (PendingScanCard) is where each queued scan is tracked and opened. This
 * screen stays a pure, distraction-free viewfinder — no thumbnail tray or badge.
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
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import { CaptureButton } from '../components/CaptureButton';
import { FrameOverlay, FrameState } from '../components/FrameOverlay';
import { FlashOverlay, FlashOverlayRef } from '../components/FlashOverlay';
import { enqueueScan } from '../services/scanQueue';
import { persistPendingPhoto, deletePendingPhoto } from '../services/storage';
import { logLatency } from '../services/latencyLog';
import { captureImageActions } from '../services/captureImageActions';
import { colors, spacing, typography } from '../theme';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useAuth } from '../context/AuthContext';

// Label-placement frame — both the VISUAL GUIDE and the crop region. The full
// photo is captured, then cropped to this rectangle before submit (see
// computeFrameCrop). The frame is sized to ≈100% of the useful zone (the whole band
// between the floating controls and the shutter) so the operator can place the ENTIRE
// label inside — earlier the frame was a small landscape rectangle and labels that
// overflowed it were cropped away, losing OCR content (the regression we fix here).
const TOP_CONTROL_BAND_H = 56;
const BOTTOM_CONTROLS_H = 88;
// Reserve a little room below the frame for the instruction caption.
const CAPTION_RESERVE = 36;

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
  geometry: {
    screenWidth: number;
    screenHeight: number;
    frameLeft: number;
    frameTop: number;
    frameWidth: number;
    frameHeight: number;
  },
): { originX: number; originY: number; width: number; height: number } | null {
  if (!photoWidth || !photoHeight) return null;
  const { screenWidth, screenHeight, frameLeft, frameTop, frameWidth, frameHeight } = geometry;

  // Orientation guard: photo and screen must share orientation for this mapping.
  if (screenWidth > screenHeight !== photoWidth > photoHeight) return null;

  // Cover fit: one scale factor; the larger axis ratio wins so the photo covers
  // the whole screen. The centered overflow is the offset we subtract back out.
  const scale = Math.max(screenWidth / photoWidth, screenHeight / photoHeight);
  const offsetX = (photoWidth * scale - screenWidth) / 2;
  const offsetY = (photoHeight * scale - screenHeight) / 2;

  // Expand the frame rect (in screen space) by the safety margin on every side
  // before inverting the transform, so edges near the brackets aren't clipped.
  const marginX = frameWidth * CROP_SAFETY_MARGIN;
  const marginY = frameHeight * CROP_SAFETY_MARGIN;
  const cropLeft = frameLeft - marginX;
  const cropTop = frameTop - marginY;
  const cropWidth = frameWidth + marginX * 2;
  const cropHeight = frameHeight + marginY * 2;

  let originX = (cropLeft + offsetX) / scale;
  let originY = (cropTop + offsetY) / scale;
  let width = cropWidth / scale;
  let height = cropHeight / scale;

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
  const { businessPortalId, businessProfile } = useAuth();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const navigation = useNavigation<NavProp>();
  const bottomTrayHeight = insets.bottom + BOTTOM_CONTROLS_H;
  const frameLeft = screenWidth * 0.03;
  const frameWidth = screenWidth - frameLeft * 2;
  const frameTop = insets.top + TOP_CONTROL_BAND_H;
  const frameHeight = Math.max(
    180,
    screenHeight - frameTop - bottomTrayHeight - CAPTION_RESERVE,
  );
  const frameGeometry = {
    screenWidth,
    screenHeight,
    frameLeft,
    frameTop,
    frameWidth,
    frameHeight,
  };
  // Mount the live preview only while this screen is focused (freed whenever another
  // screen sits on top; released for good once popped back to Articles).
  const isFocused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [frameState, setFrameState] = useState<FrameState>('ready');
  const [taking, setTaking] = useState(false);
  // Torch toggle (off/on). The old 3-state `flash` prop only fired AT capture, so the
  // button gave no visible feedback and read as broken. A torch lights the scene
  // immediately (clearly "works") AND stays on through the capture.
  const [torchOn, setTorchOn] = useState(false);

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

    let photo: Awaited<ReturnType<CameraView['takePictureAsync']>> | undefined;
    try {
      photo = await cameraRef.current.takePictureAsync({
        // Max fidelity so small print on the label OCRs well (no source-side
        // recompression beyond the single capture encode).
        quality: 1.0,
        // Apply sensor rotation (do NOT skip processing) so width/height describe the
        // UPRIGHT image matching the portrait preview. skipProcessing:true returned an
        // unrotated buffer on Android, which made computeFrameCrop crop the wrong region.
        skipProcessing: false,
      });
    } catch (err) {
      console.error('Capture error:', err);
      if (mountedRef.current) {
        setFrameState('error');
        setTimeout(() => {
          if (mountedRef.current) setFrameState('ready');
        }, 2500);
        setTaking(false);
      }
      return;
    }

    // The camera is FREE the instant the frame is grabbed: re-enable the shutter NOW
    // for fluid chained capture (fire again immediately). The heavy pipeline — durable
    // copy + frame crop + downscale + enqueue — runs in the BACKGROUND, off the shutter's
    // critical path, so nothing blocks the next shot.
    if (mountedRef.current) {
      setTaking(false);
      setFrameState('ready');
    }
    if (!photo || !mountedRef.current) return;

    const capturedPhoto = photo;
    const capturedAt = new Date().toISOString();
    const barcodeRaw = lastBarcodeRef.current?.data;
    lastBarcodeRef.current = null;

    void (async () => {
      try {
        // Durable copy FIRST, before anything else touches the file. expo-camera's raw
        // capture lives in an OS-managed Caches subdirectory that is NOT guaranteed to
        // survive — under rapid chained capture it can vanish mid-crop (observed on
        // device: NSCocoaErrorDomain 260 "no such file" at UPLOAD time). Crop from OUR
        // OWN durable copy so a slow crop/enqueue never races a source the OS can reclaim.
        const scanId = uuidv4();
        const durableRawUri = await persistPendingPhoto(`${scanId}-raw`, capturedPhoto.uri);
        if (!durableRawUri) throw new Error('Could not persist the captured photo');

        // ALWAYS produce a downscaled JPEG for upload + Vision OCR, and apply the frame
        // crop WHEN available. Decoupling the resize from the crop is deliberate: a crop
        // failure (orientation mismatch → computeFrameCrop null) must NOT ship a full-size
        // image to Vision. Cap the LONG edge at ~1600px + compress 0.8 (Tier 7).
        let croppedUri: string | undefined;
        let framed = false;
        const crop = computeFrameCrop(
          capturedPhoto.width,
          capturedPhoto.height,
          frameGeometry,
        );
        if (!crop) {
          logLatency('frame_crop_skipped', {
            photo: `${capturedPhoto.width}x${capturedPhoto.height}`,
            screen: `${Math.round(screenWidth)}x${Math.round(screenHeight)}`,
          });
        }
        const srcW = crop ? crop.width : capturedPhoto.width;
        const srcH = crop ? crop.height : capturedPhoto.height;
        const resize =
          srcW >= srcH ? { width: Math.min(srcW, 1600) } : { height: Math.min(srcH, 1600) };
        try {
          // Keep the captured orientation in the stored/uploaded JPEG. Operators hold
          // the phone in landscape while the app remains portrait-locked, so the label
          // is intentionally sideways in this file (like the OCR source). The single
          // counter-clockwise rotation belongs only to the display components.
          const out = await ImageManipulator.manipulateAsync(
            durableRawUri,
            captureImageActions(crop, resize),
            { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
          );
          croppedUri = out.uri;
          framed = crop != null;
        } catch (e) {
          console.warn('Immediate crop/resize failed; durable raw copy will be used:', e);
        }

        // Enqueue — the scan queue owns submit + extraction from here. Never throws;
        // a submit failure surfaces as a 'submit_error' card at home.
        const scan = await enqueueScan({
          id: scanId,
          tempUri: croppedUri ?? durableRawUri,
          barcodeRaw,
          capturedAt,
          tradeCode: businessProfile.code,
          businessPortalId: businessPortalId ?? undefined,
        });
        logLatency('capture', { framed: String(framed) });
        // Clean up the raw intermediate — UNLESS enqueueScan's own persist failed and
        // fell back to this exact uri (then it's the scan's only copy; keep it).
        if (scan.photoUri !== durableRawUri) void deletePendingPhoto(durableRawUri);
      } catch (err) {
        // A shot must NEVER be lost silently (prod audit): the only throw path here is
        // the durable-copy failure, so fall back to enqueueing the ORIGINAL cache
        // capture as-is (uncropped — degraded but recoverable; enqueueScan
        // retries its own durable copy and tolerates a cache uri). If even that fails,
        // the error card at home is the operator's signal.
        console.error('Background capture pipeline error:', err);
        try {
          await enqueueScan({
            tempUri: capturedPhoto.uri,
            barcodeRaw,
            capturedAt,
            tradeCode: businessProfile.code,
            businessPortalId: businessPortalId ?? undefined,
          });
          logLatency('capture', { framed: 'false', fallback: 'raw_cache' });
        } catch (fallbackErr) {
          console.error('Capture fallback enqueue failed — shot lost:', fallbackErr);
        }
      }
    })();
  }, [
    taking,
    frameGeometry,
    screenWidth,
    screenHeight,
    businessPortalId,
    businessProfile.code,
  ]);

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
    setTorchOn((on) => !on);
  }, []);

  // ── Leave the capture module → back to Articles (pops Camera → unmounts it) ──
  const closeCapture = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('ArticleList');
    }
  }, [navigation]);

  const flashIcon = torchOn ? 'flash' : 'flash-off';

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
          flash={torchOn ? 'on' : 'off'}
          enableTorch={torchOn}
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
        frameTop={frameTop}
        frameLeft={frameLeft}
        frameWidth={frameWidth}
        frameHeight={frameHeight}
      />

      {/* Floating controls only: no opaque header obscuring the preview. */}
      <View
        style={[
          styles.topControls,
          {
            top: insets.top + spacing.sm,
          },
        ]}
      >
        <Pressable
          onPress={closeCapture}
          style={styles.topControlButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Revenir aux articles"
        >
          <MaterialCommunityIcons name="arrow-left" size={23} color={colors.onPrimary} />
        </Pressable>
        <Pressable
          onPress={toggleFlash}
          style={[styles.topControlButton, torchOn && styles.topControlActive]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={torchOn ? 'Éteindre la torche' : 'Allumer la torche'}
          accessibilityState={{ selected: torchOn }}
        >
          <MaterialCommunityIcons name={flashIcon} size={22} color={colors.onPrimary} />
        </Pressable>
      </View>

      {/* Floating shutter only: the photo stays visible down to the safe area. */}
      <View
        style={[
          styles.bottomTray,
          {
            height: bottomTrayHeight,
            paddingBottom: insets.bottom + spacing.md,
          },
        ]}
      >
        <CaptureButton onPress={takePhoto} loading={taking} disabled={taking} />
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
  topControls: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topControlButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Torch ON — the brand fill makes the state unmistakable.
  topControlActive: {
    backgroundColor: colors.primary,
    borderColor: 'rgba(255,255,255,0.34)',
  },
  bottomTray: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
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
