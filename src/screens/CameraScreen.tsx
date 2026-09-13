/**
 * CameraScreen — Live viewfinder, barcode detect, chained capture (workflow v1).
 *
 * Flow: aim → tap shutter → the photo is cropped and enqueued in the SCAN QUEUE
 * (background submit + extraction) → the operator keeps shooting immediately, no
 * modal, no wait. The on-screen frame is BOTH the placement guide AND the crop
 * region applied before the photo is enqueued. If that mapping fails, no
 * uncropped original is uploaded.
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
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Alert,
  AppState,
  Linking,
  Platform,
  type LayoutChangeEvent,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'react-native';
import {
  CameraView,
  useCameraPermissions,
  BarcodeScanningResult,
  type CameraOrientation,
  type ResponsiveOrientationChanged,
} from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIsFocused, useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import { CaptureButton } from '../components/CaptureButton';
import { FrameOverlay, FrameState } from '../components/FrameOverlay';
import { FlashOverlay, FlashOverlayRef } from '../components/FlashOverlay';
import { enqueueScan } from '../services/scanQueue';
import { persistPendingPhoto, deletePendingPhoto } from '../services/storage';
import { logLatency } from '../services/latencyLog';
import { computeFrameCrop } from '../services/frameCrop';
import { cameraLayout } from '../services/cameraLayout';
import { physicalRotationForLandscapeOutput } from '../services/captureOrientation';
import {
  BARCODE_CAPTURE_FRESH_MS,
  barcodePayloadAtShutter,
} from '../services/gs1';
import { colors, spacing, typography } from '../theme';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useAuth } from '../context/AuthContext';
import { RECAPTURE_GUIDANCE } from '../services/extractionUsability';

// Keep this prop stable: toggling native barcodeScannerEnabled on Android
// rebuilds CameraX's use cases and cancels a photo already being captured.
const BARCODE_SETTINGS = {
  barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],
} satisfies NonNullable<React.ComponentProps<typeof CameraView>['barcodeScannerSettings']>;

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Camera'>;
type RouteType = RouteProp<RootStackParamList, 'Camera'>;

export function CameraScreen() {
  const { businessProfile } = useAuth();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [sceneSize, setSceneSize] = useState<{ width: number; height: number } | null>(null);
  // Android's window can include system bars outside this native-stack scene.
  // Measure the scene, then size the native preview and crop from one layout.
  const { width: screenWidth, height: screenHeight } = Platform.OS === 'android'
    ? sceneSize ?? window
    : window;
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteType>();
  const isRecapture = route.params?.recapture === true;
  const frameGeometry = cameraLayout({
    platform: Platform.OS, width: screenWidth, height: screenHeight,
    insetTop: insets.top, insetBottom: insets.bottom,
  });
  const { frameLeft, frameWidth, frameTop, frameHeight, bottomTrayHeight } = frameGeometry;
  // Mount the live preview only while this screen is focused (freed whenever another
  // screen sits on top; released for good once popped back to Articles).
  const isFocused = useIsFocused();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  useLayoutEffect(() => {
    if (Platform.OS !== 'android' || !isFocused) return;
    // Let the native stack apply the active screen's style on every transition.
    // The permission screen is light; only the live camera needs white icons.
    navigation.setOptions({ statusBarStyle: permission?.granted ? 'light' : 'dark' });
  }, [isFocused, navigation, permission?.granted]);
  const [frameState, setFrameState] = useState<FrameState>('ready');
  const [taking, setTaking] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraSession, setCameraSession] = useState(0);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const cameraVisible = isFocused && (Platform.OS !== 'android' || appActive);
  // Torch toggle (off/on). The old 3-state `flash` prop only fired AT capture, so the
  // button gave no visible feedback and read as broken. A torch lights the scene
  // immediately (clearly "works") AND stays on through the capture.
  const [torchOn, setTorchOn] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  const flashRef = useRef<FlashOverlayRef>(null);
  const lastBarcodeRef = useRef<{
    result: BarcodeScanningResult;
    detectedAt: number;
  } | null>(null);
  const barcodeExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `width > height` is not a reliable indicator on iOS: the camera may preserve
  // a portrait-sized pixel buffer while the phone was held landscape. Expo Camera
  // supplies the physical orientation independently of the locked app UI.
  const captureOrientationRef = useRef<CameraOrientation>('portrait');
  const mountedRef = useRef(true);
  const captureLockRef = useRef(false);
  const captureGenerationRef = useRef(0);
  const cameraReadyRef = useRef(false);
  const cameraVisibleRef = useRef(cameraVisible);
  cameraVisibleRef.current = cameraVisible;
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const abandonNativeCapture = useCallback(() => {
    // Android may cancel its file-writing coroutine without settling the old JS
    // promise when the view unmounts. A new camera must never inherit that lock.
    captureGenerationRef.current += 1;
    captureLockRef.current = false;
    setTaking(false);
  }, []);

  const resetCamera = useCallback(() => {
    abandonNativeCapture();
    lastBarcodeRef.current = null;
    if (barcodeExpiryRef.current) clearTimeout(barcodeExpiryRef.current);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setFrameState('ready');
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraError(null);
    setCameraSession((session) => session + 1);
  }, [abandonNativeCapture]);

  const handleCameraReady = useCallback(() => {
    if (!mountedRef.current || !cameraVisibleRef.current) return;
    cameraReadyRef.current = true;
    setCameraReady(true);
    setCameraError(null);
  }, []);

  const handleCameraMountError = useCallback(({ message }: { message: string }) => {
    if (!mountedRef.current || !cameraVisibleRef.current) return;
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraError('La caméra est indisponible. Vérifiez son autorisation et fermez les autres applications qui l’utilisent.');
    console.warn('Camera initialization failed:', message);
  }, []);

  const handleSceneLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (Platform.OS !== 'android' || layout.width <= 0 || layout.height <= 0) return;
    setSceneSize((previous) => previous?.width === layout.width && previous.height === layout.height
      ? previous : { width: layout.width, height: layout.height });
  }, []);

  // ── Permission guard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (permission?.status === 'undetermined') void requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getPermission();
      if (Platform.OS !== 'android') return;
      // Gate synchronously; a shutter event may arrive before the next render.
      if (state !== 'active') {
        abandonNativeCapture();
        cameraVisibleRef.current = false;
        cameraReadyRef.current = false;
        setCameraReady(false);
        setTorchOn(false);
      }
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, [getPermission, abandonNativeCapture]);

  // ── Mark unmounted so a still-running capture doesn't touch state after teardown ──
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (barcodeExpiryRef.current) clearTimeout(barcodeExpiryRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  // ── Reset the barcode hint when the live viewfinder regains focus ─────────
  useEffect(() => {
    lastBarcodeRef.current = null;
    if (barcodeExpiryRef.current) clearTimeout(barcodeExpiryRef.current);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setFrameState('ready');
    if (!cameraVisible || !permission?.granted) {
      abandonNativeCapture();
      cameraReadyRef.current = false;
      setCameraReady(false);
      setCameraError(null);
      setTorchOn(false);
    }
  }, [cameraVisible, permission?.granted, abandonNativeCapture]);

  const handleResponsiveOrientationChanged = useCallback(
    ({ orientation }: ResponsiveOrientationChanged) => {
      captureOrientationRef.current = orientation;
    },
    [],
  );

  // ── Take a photo and enqueue it — TERMINAL: the operator keeps shooting ────
  const takePhoto = useCallback(async () => {
    // React state alone permits two taps before a render. Lock synchronously,
    // and never ask CameraX for a capture until its ready event has arrived.
    const camera = cameraRef.current;
    if (!camera || captureLockRef.current || !cameraReadyRef.current
      || !cameraVisibleRef.current || !permission?.granted
      || (Platform.OS === 'android' && !sceneSize) || frameHeight <= 0) return;
    captureLockRef.current = true;
    const captureGeneration = ++captureGenerationRef.current;
    const shutterAt = Date.now();
    const barcodeRaw = barcodePayloadAtShutter(lastBarcodeRef.current, shutterAt);
    lastBarcodeRef.current = null;
    if (barcodeExpiryRef.current) clearTimeout(barcodeExpiryRef.current);
    // Freeze the physical orientation at the shutter press. A user turning the
    // phone while the JPEG is written must not change this photo's transform.
    const orientationAtShutter = captureOrientationRef.current;
    setTaking(true);
    setFrameState('capturing');
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    flashRef.current?.trigger();

    let photo: Awaited<ReturnType<CameraView['takePictureAsync']>> | undefined;
    try {
      photo = await camera.takePictureAsync({
        // Max fidelity so small print on the label OCRs well (no source-side
        // recompression beyond the single capture encode).
        quality: 1.0,
        // Apply sensor rotation (do NOT skip processing) so width/height describe the
        // UPRIGHT image matching the portrait preview. skipProcessing:true returned an
        // unrotated buffer on Android, which made computeFrameCrop crop the wrong region.
        skipProcessing: false,
        // Back-camera captures must never inherit a mirrored preview transform.
        mirror: false,
      });
    } catch (err) {
      console.warn('Capture error:', err);
      if (captureGeneration === captureGenerationRef.current && mountedRef.current
        && cameraVisibleRef.current && cameraRef.current === camera) {
        setFrameState('error');
        Alert.alert('Photo non prise', 'La caméra n’a pas pu prendre la photo. Réessayez ; si le problème persiste, relancez la caméra.', [
          { text: 'Réessayer', style: 'cancel' },
          { text: 'Relancer la caméra', onPress: resetCamera },
        ]);
      }
      return;
    } finally {
      if (captureGeneration === captureGenerationRef.current) {
        captureLockRef.current = false;
        if (mountedRef.current) setTaking(false);
      }
    }

    if (captureGeneration !== captureGenerationRef.current) return;

    // The camera is FREE the instant the frame is grabbed: re-enable the shutter NOW
    // for fluid chained capture (fire again immediately). The heavy pipeline — durable
    // copy + frame crop + downscale + enqueue — runs in the BACKGROUND, off the shutter's
    // critical path, so nothing blocks the next shot.
    if (mountedRef.current && cameraVisibleRef.current) {
      setFrameState('ready');
    }
    if (!photo || !mountedRef.current) return;

    const capturedPhoto = photo;
    const capturedAt = new Date(shutterAt).toISOString();

    void (async () => {
      let durableRawUri: string | null = null;
      try {
        // Durable copy FIRST, before anything else touches the file. expo-camera's raw
        // capture lives in an OS-managed Caches subdirectory that is NOT guaranteed to
        // survive — under rapid chained capture it can vanish mid-crop (observed on
        // device: NSCocoaErrorDomain 260 "no such file" at UPLOAD time). Crop from OUR
        // OWN durable copy so a slow crop/enqueue never races a source the OS can reclaim.
        const scanId = uuidv4();
        durableRawUri = await persistPendingPhoto(`${scanId}-raw`, capturedPhoto.uri);
        if (!durableRawUri) throw new Error('Could not persist the captured photo');

        // expo-image-manipulator first bakes the EXIF rotation into the pixels on
        // iOS. Calculate the frame crop only *after* that normalization; using the
        // dimensions returned by CameraView before this step caused the observed
        // horizontal drift because crop coordinates referred to a different basis.
        const normalizeContext = ImageManipulator.ImageManipulator.manipulate(durableRawUri);
        const normalizedImage = await normalizeContext.renderAsync();
        try {
          // Cropping is mandatory: the raw/full-frame image must never reach OCR.
          // Android's guide is centered on both preview axes, so both native
          // quarter-turn directions select the same crop. iOS uses its physical
          // orientation callback for the existing asymmetric guide.
          const previewQuarterTurn = orientationAtShutter === 'landscapeLeft'
            ? 'clockwise'
            : 'counterclockwise';
          const crop = computeFrameCrop(
            normalizedImage.width,
            normalizedImage.height,
            frameGeometry,
            previewQuarterTurn,
          );
          if (!crop) {
            logLatency('frame_crop_skipped', {
              photo: `${normalizedImage.width}x${normalizedImage.height}`,
              screen: `${Math.round(frameGeometry.screenWidth)}x${Math.round(frameGeometry.screenHeight)}`,
            });
            throw new Error('The visible frame could not be mapped to the captured photo');
          }
          // Materialize the crop first. Start a fresh native manipulation context
          // from those cropped pixels so orientation is decided from the actual
          // post-crop geometry, never from the sensor or preview dimensions.
          const cropContext = ImageManipulator.ImageManipulator.manipulate(normalizedImage);
          cropContext.crop(crop);
          const croppedImage = await cropContext.renderAsync();
          try {
            const physicalRotationDegrees = physicalRotationForLandscapeOutput(
              croppedImage.width,
              croppedImage.height,
            );
            const outputWidth = physicalRotationDegrees === 0
              ? croppedImage.width
              : croppedImage.height;
            const outputHeight = physicalRotationDegrees === 0
              ? croppedImage.height
              : croppedImage.width;
            const resize = outputWidth >= outputHeight
              ? { width: Math.min(outputWidth, 1600) }
              : { height: Math.min(outputHeight, 1600) };

            const rotationContext = ImageManipulator.ImageManipulator.manipulate(croppedImage);
            if (physicalRotationDegrees !== 0) {
              rotationContext.rotate(physicalRotationDegrees);
            }
            rotationContext.resize(resize);
            const outputImage = await rotationContext.renderAsync();
            let out: Awaited<ReturnType<typeof outputImage.saveAsync>>;
            try {
              if (outputImage.height > outputImage.width) {
                throw new Error(
                  `Post-crop photo is not landscape: ${outputImage.width}x${outputImage.height}`,
                );
              }
              out = await outputImage.saveAsync({
                compress: 0.8,
                format: ImageManipulator.SaveFormat.JPEG,
              });

              logLatency('capture_geometry', {
                source: `${capturedPhoto.width}x${capturedPhoto.height}`,
                scene: `${screenWidth}x${screenHeight}`,
                preview: `${frameGeometry.screenWidth}x${frameGeometry.screenHeight}`,
                frame: `${frameGeometry.frameLeft},${frameGeometry.frameTop},${frameGeometry.frameWidth}x${frameGeometry.frameHeight}`,
                normalized: `${normalizedImage.width}x${normalizedImage.height}`,
                crop: `${crop.originX},${crop.originY},${crop.width}x${crop.height}`,
                cropped: `${croppedImage.width}x${croppedImage.height}`,
                output: `${outputImage.width}x${outputImage.height}`,
                orientation: Platform.OS === 'android' ? 'native-auto' : orientationAtShutter,
                preview_turn: previewQuarterTurn,
                physical_rotation: String(physicalRotationDegrees),
                mirrored: 'false',
              });

              // Only the verified, cropped JPEG may enter the scan queue and reach OCR.
              await enqueueScan({
                id: scanId,
                tempUri: out.uri,
                barcodeRaw,
                capturedAt,
                photoBaseRotationDegrees: 0,
              });
              logLatency('capture', { framed: 'true' });
              // enqueueScan has committed its own durable cropped copy; the raw
              // intermediate is no longer part of the offline operation.
              void deletePendingPhoto(durableRawUri);
            } finally {
              outputImage.release();
              rotationContext.release();
            }
          } finally {
            croppedImage.release();
            cropContext.release();
          }
        } finally {
          normalizedImage.release();
          normalizeContext.release();
        }
      } catch (err) {
        console.error('Cropped capture pipeline error — photo not enqueued:', err);
        if (durableRawUri) void deletePendingPhoto(durableRawUri);
        if (mountedRef.current) {
          setFrameState('error');
          Alert.alert(
            'Photo non envoyée',
            'Le découpage selon le cadre a échoué. Reprenez la photo : aucune image complète n’a été envoyée.',
          );
          errorTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setFrameState('ready');
          }, 2500);
        }
      }
    })();
  }, [
    permission?.granted,
    sceneSize,
    frameHeight,
    resetCamera,
    frameGeometry,
    screenWidth,
    screenHeight,
    businessProfile.code,
  ]);

  // ── Barcode detected — store for the next capture, no auto-shoot ───────────
  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (captureLockRef.current || !cameraReadyRef.current || !cameraVisibleRef.current) return;
      lastBarcodeRef.current = { result, detectedAt: Date.now() };
      if (barcodeExpiryRef.current) clearTimeout(barcodeExpiryRef.current);
      barcodeExpiryRef.current = setTimeout(() => {
        lastBarcodeRef.current = null;
        if (mountedRef.current) setFrameState('ready');
      }, BARCODE_CAPTURE_FRESH_MS);
      setFrameState('barcodeFound');
    },
    []
  );

  const toggleFlash = useCallback(() => {
    if (captureLockRef.current || !cameraReadyRef.current) return;
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
          onPress={() => permission?.canAskAgain === false ? void Linking.openSettings() : void requestPermission()}
          style={styles.permissionButton}
          android_ripple={{ color: colors.primaryContainer }}
          accessibilityRole="button"
          accessibilityLabel={permission?.canAskAgain === false ? 'Ouvrir les réglages' : 'Autoriser l’accès à la caméra'}
        >
          <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
            {permission?.canAskAgain === false ? 'Ouvrir les réglages' : 'Autoriser l’accès'}
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
    <View style={styles.root} onLayout={handleSceneLayout}>
      {/* Android 13/14 still need the original translucent window for the measured
          preview bounds. Android 15+ uses enforced edge-to-edge and native route styles. */}
      {isFocused && (Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) < 35)) && (
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      )}

      {/* Camera preview — bounds shared with the crop. Mounted only while focused so the single
          camera resource is freed whenever we leave the live viewfinder. */}
      {cameraVisible ? (
        <CameraView
          key={cameraSession}
          ref={cameraRef}
          style={Platform.OS === 'android'
            ? [StyleSheet.absoluteFill, { bottom: screenHeight - frameGeometry.screenHeight }]
            : StyleSheet.absoluteFill}
          facing="back"
          mirror={false}
          onCameraReady={handleCameraReady}
          onMountError={handleCameraMountError}
          // Keep the application UI portrait while letting the native iOS camera
          // use the phone's *physical* orientation for the captured pixels. This
          // is essential when the operator holds the phone landscape: the source
          // buffer then matches the live frame before our exact crop + matching
          // quarter-turn are applied. This prop does not rotate the React Native UI.
          responsiveOrientationWhenOrientationLocked={Platform.OS === 'ios'}
          onResponsiveOrientationChanged={
            Platform.OS === 'ios' ? handleResponsiveOrientationChanged : undefined
          }
          // Android uses continuous torch only; don't also request a capture flash.
          flash={Platform.OS === 'android' ? 'off' : torchOn ? 'on' : 'off'}
          enableTorch={torchOn}
          onBarcodeScanned={handleBarcodeScanned}
          barcodeScannerSettings={BARCODE_SETTINGS}
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

      {isRecapture ? (
        <View
          style={[styles.recaptureHint, { top: frameTop + spacing.md }]}
          accessibilityRole="alert"
        >
          <MaterialCommunityIcons name="camera-retake-outline" size={18} color={colors.onPrimary} />
          <Text style={[typography.labelMedium, styles.recaptureHintText]}>
            {RECAPTURE_GUIDANCE}
          </Text>
        </View>
      ) : null}

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
          disabled={taking || !cameraReady}
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
        <CaptureButton onPress={takePhoto} loading={taking} disabled={taking || !cameraReady || (Platform.OS === 'android' && !sceneSize) || frameHeight <= 0} />
      </View>

      {cameraError ? (
        <View style={styles.cameraError} accessibilityRole="alert">
          <Text style={[typography.bodyMedium, { color: colors.onPrimary, textAlign: 'center' }]}>{cameraError}</Text>
          <Pressable onPress={resetCamera} style={styles.permissionButton} accessibilityRole="button">
            <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>Relancer la caméra</Text>
          </Pressable>
        </View>
      ) : null}

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
  cameraError: {
    position: 'absolute',
    top: '40%',
    left: spacing.lg,
    right: spacing.lg,
    padding: spacing.lg,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
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
  recaptureHint: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  recaptureHintText: {
    color: colors.onPrimary,
    flexShrink: 1,
    textAlign: 'center',
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
