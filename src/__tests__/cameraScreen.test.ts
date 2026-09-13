import * as React from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => mockHarness.useState(initial),
  useRef: (initial: unknown) => mockHarness.useRef(initial),
  useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) =>
    mockHarness.useEffect(effect, dependencies),
  useLayoutEffect: (effect: () => void | (() => void), dependencies?: unknown[]) =>
    mockHarness.useEffect(effect, dependencies),
  useCallback: (callback: unknown, dependencies?: unknown[]) =>
    mockHarness.useMemo(() => callback, dependencies),
  useMemo: (factory: () => unknown, dependencies?: unknown[]) =>
    mockHarness.useMemo(factory, dependencies),
}));

jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StatusBar: 'StatusBar',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
  Platform: { OS: 'android' },
  StyleSheet: {
    create: (styles: unknown) => styles,
    absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  },
  useWindowDimensions: () => ({ width: 360, height: 800, scale: 3, fontScale: 1 }),
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppStateListeners.add(listener);
      return { remove: () => mockAppStateListeners.delete(listener) };
    },
  },
}));

jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [
    mockPermission,
    mockRequestPermission,
    mockGetPermission,
  ],
}));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: {} }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('../components/CaptureButton', () => ({ CaptureButton: 'CaptureButton' }));
jest.mock('../components/FrameOverlay', () => ({ FrameOverlay: 'FrameOverlay' }));
jest.mock('../components/FlashOverlay', () => ({ FlashOverlay: 'FlashOverlay' }));
jest.mock('../services/scanQueue', () => ({ enqueueScan: jest.fn() }));
jest.mock('../services/storage', () => ({
  persistPendingPhoto: jest.fn(),
  deletePendingPhoto: jest.fn(),
}));
jest.mock('../services/latencyLog', () => ({ logLatency: jest.fn() }));
jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ businessProfile: { code: 'poissonnerie' } }),
}));
jest.mock('../theme', () => ({
  colors: {},
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  typography: {},
}));

import { CameraScreen } from '../screens/CameraScreen';
import * as ImageManipulator from 'expo-image-manipulator';
import { enqueueScan } from '../services/scanQueue';
import { persistPendingPhoto } from '../services/storage';

type TestElement = React.ReactElement<Record<string, any>>;
type EffectSlot = {
  dependencies?: unknown[];
  cleanup?: () => void;
};

const mockAppStateListeners = new Set<(state: string) => void>();
const mockRequestPermission = jest.fn();
const mockGetPermission = jest.fn();
let mockPermission = { granted: true, canAskAgain: true, status: 'granted' };
const mockNavigation = { canGoBack: () => true, goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() };
let mockHarness: CameraHarness;

function dependenciesMatch(previous: unknown[] | undefined, next: unknown[] | undefined) {
  return previous !== undefined && next !== undefined &&
    previous.length === next.length && previous.every((item, index) => Object.is(item, next[index]));
}

/**
 * The repository's Jest environment is Node and has no native renderer. This
 * small host exercises the actual screen's event callbacks, retains hook state,
 * commits refs before effects, and deliberately permits two presses before the
 * next render (the race React's asynchronous state updates must tolerate).
 */
class CameraHarness {
  private slots: any[] = [];
  private cursor = 0;
  private dirty = false;
  private effects: (() => void)[] = [];
  private effectSlots = new Set<EffectSlot>();
  private previousCameraRef: { current: unknown } | null = null;
  tree!: TestElement;
  camera = { takePictureAsync: jest.fn() };

  useState(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) {
      this.slots[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [this.slots[index], (value: any) => {
      const next = typeof value === 'function' ? value(this.slots[index]) : value;
      if (!Object.is(this.slots[index], next)) {
        this.slots[index] = next;
        this.dirty = true;
      }
    }];
  }

  useRef(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = { current: initial };
    return this.slots[index];
  }

  useMemo(factory: () => unknown, dependencies?: unknown[]) {
    const index = this.cursor++;
    const previous = this.slots[index];
    if (!previous || !dependenciesMatch(previous.dependencies, dependencies)) {
      this.slots[index] = { value: factory(), dependencies };
    }
    return this.slots[index].value;
  }

  useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
    const index = this.cursor++;
    const previous: EffectSlot | undefined = this.slots[index];
    if (previous && dependenciesMatch(previous.dependencies, dependencies)) return;
    const slot: EffectSlot = { dependencies };
    this.slots[index] = slot;
    this.effects.push(() => {
      previous?.cleanup?.();
      if (previous) this.effectSlots.delete(previous);
      slot.cleanup = effect() || undefined;
      this.effectSlots.add(slot);
    });
  }

  render() {
    let renderCount = 0;
    do {
      if (++renderCount > 20) throw new Error('Camera screen did not settle after effects');
      this.cursor = 0;
      this.dirty = false;
      this.tree = CameraScreen();
      const cameraRef = this.find('CameraView')?.props.ref ?? null;
      if (this.previousCameraRef && this.previousCameraRef !== cameraRef) {
        this.previousCameraRef.current = null;
      }
      if (cameraRef) cameraRef.current = this.camera;
      this.previousCameraRef = cameraRef;
      const flashRef = this.find('FlashOverlay')?.props.ref;
      if (flashRef) flashRef.current = { trigger: jest.fn() };
      const effects = this.effects.splice(0);
      effects.forEach((effect) => effect());
    } while (this.dirty);
    return this;
  }

  find(type: string, node: React.ReactNode = this.tree): TestElement | undefined {
    if (!React.isValidElement(node)) return undefined;
    const element = node as TestElement;
    if ((element.type as unknown) === type) return element;
    for (const child of React.Children.toArray(element.props.children)) {
      const found = this.find(type, child);
      if (found) return found;
    }
    return undefined;
  }

  props(type: string) {
    const element = this.find(type);
    if (!element) throw new Error(`Expected mounted ${type}`);
    return element.props;
  }

  ready() {
    this.props('CameraView').onCameraReady();
    return this.render();
  }

  layout(width = 360, height = 728) {
    this.tree.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
    return this.render();
  }

  appState(state: 'active' | 'background' | 'inactive') {
    AppState.currentState = state;
    for (const listener of mockAppStateListeners) listener(state);
    return this.render();
  }

  unmount() {
    if (this.previousCameraRef) this.previousCameraRef.current = null;
    for (const slot of this.effectSlots) slot.cleanup?.();
  }
}

function deferredCapture() {
  type Photo = { uri: string; width: number; height: number } | undefined;
  let resolve!: (value: Photo) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Photo>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  mockHarness.camera.takePictureAsync.mockReturnValue(promise);
  return { resolve, reject };
}

describe('CameraScreen native capture lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    Platform.OS = 'android';
    AppState.currentState = 'active';
    mockAppStateListeners.clear();
    mockPermission = { granted: true, canAskAgain: true, status: 'granted' };
    mockHarness = new CameraHarness();
  });

  afterEach(() => {
    mockHarness.unmount();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits for native readiness before allowing the first capture', async () => {
    mockHarness.render().layout();
    expect(mockHarness.props('CaptureButton').disabled).toBe(true);
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).not.toHaveBeenCalled();

    mockHarness.ready();
    expect(mockHarness.props('CaptureButton').disabled).toBe(false);
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(1);
  });

  it('waits for usable Android preview dimensions even if native readiness arrives first', async () => {
    mockHarness.render().ready().layout(0, 0);
    expect(mockHarness.props('CaptureButton').disabled).toBe(true);
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).not.toHaveBeenCalled();

    mockHarness.layout();
    expect(mockHarness.props('CaptureButton').disabled).toBe(false);
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(1);
  });

  it('uses the enlarged Android guide and the shorter native preview for the saved crop', async () => {
    const normalizedImage = { width: 1080, height: 2052, release: jest.fn() };
    const croppedImage = { width: 1016, height: 1524, release: jest.fn() };
    const outputImage = {
      width: 1524, height: 1016, release: jest.fn(),
      saveAsync: jest.fn().mockResolvedValue({ uri: 'file:///cropped.jpg' }),
    };
    const normalizeContext = { renderAsync: jest.fn().mockResolvedValue(normalizedImage), release: jest.fn() };
    const cropContext = { crop: jest.fn(), renderAsync: jest.fn().mockResolvedValue(croppedImage), release: jest.fn() };
    const outputContext = {
      rotate: jest.fn(), resize: jest.fn(),
      renderAsync: jest.fn().mockResolvedValue(outputImage), release: jest.fn(),
    };
    jest.mocked(ImageManipulator.ImageManipulator.manipulate)
      .mockReturnValueOnce(normalizeContext as any)
      .mockReturnValueOnce(cropContext as any)
      .mockReturnValueOnce(outputContext as any);
    jest.mocked(persistPendingPhoto).mockResolvedValueOnce('file:///durable-raw.jpg');
    mockHarness.camera.takePictureAsync.mockResolvedValueOnce({
      uri: 'file:///camera.jpg', width: 1080, height: 2052,
    });
    mockHarness.render().layout(360, 728).ready();

    // The flash ends at y=76. The frame begins 12 points below and retains y=596
    // as its lower edge. CameraView is 684 points high, not the 728-point scene.
    expect(mockHarness.props('FrameOverlay')).toEqual(expect.objectContaining({
      frameTop: 88, frameHeight: 508,
    }));
    expect(mockHarness.props('CameraView').style).toEqual(expect.arrayContaining([{ bottom: 44 }]));
    await mockHarness.props('CaptureButton').onPress();
    await jest.runAllTimersAsync();

    // A source with exactly 3 pixels per preview point retains the newly exposed
    // upper band. Using scene height here would select different source pixels.
    expect(cropContext.crop).toHaveBeenCalledWith({
      originX: 32, originY: 264, width: 1016, height: 1524,
    });
    expect(outputContext.rotate).toHaveBeenCalledWith(-90);
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ tempUri: 'file:///cropped.jpg' }));
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('locks two synchronous shutter presses before React can render taking state', async () => {
    const capture = deferredCapture();
    mockHarness.render().layout().ready();
    const press = mockHarness.props('CaptureButton').onPress;
    const first = press();
    const second = press();
    expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(1);
    mockHarness.render();
    expect(mockHarness.props('CaptureButton').disabled).toBe(true);

    capture.resolve(undefined);
    await Promise.all([first, second]);
    mockHarness.render();
    expect(mockHarness.props('CaptureButton').disabled).toBe(false);
  });

  it('keeps the barcode callback installed and inert during a pending native capture', async () => {
    const capture = deferredCapture();
    mockHarness.render().layout().ready();
    const barcodeCallback = mockHarness.props('CameraView').onBarcodeScanned;
    const pending = mockHarness.props('CaptureButton').onPress();
    mockHarness.render();

    const scanningDuringCapture = mockHarness.props('CameraView').onBarcodeScanned;
    expect(typeof scanningDuringCapture).toBe('function');
    expect(scanningDuringCapture).toBe(barcodeCallback);
    scanningDuringCapture({ type: 'ean13', data: '3017620422003' });
    mockHarness.render();
    expect(mockHarness.props('FrameOverlay').state).toBe('capturing');

    capture.resolve(undefined);
    await pending;
    mockHarness.render();
    expect(mockHarness.props('CameraView').onBarcodeScanned).toBe(barcodeCallback);
  });

  it('releases the Android camera in background and waits for its new ready event on resume', async () => {
    mockHarness.render().layout().ready();
    mockHarness.appState('background');
    expect(mockHarness.find('CameraView')).toBeUndefined();
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).not.toHaveBeenCalled();

    mockHarness.appState('active');
    expect(mockGetPermission).toHaveBeenCalledTimes(1);
    expect(mockHarness.find('CameraView')).toBeDefined();
    expect(mockHarness.props('CaptureButton').disabled).toBe(true);
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).not.toHaveBeenCalled();

    mockHarness.ready();
    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(1);
  });

  it('unlocks a rejected capture so the user can immediately retry', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockHarness.camera.takePictureAsync
      .mockRejectedValueOnce(new Error('Image capture was cancelled'))
      .mockResolvedValue(undefined);
    mockHarness.render().layout().ready();

    await mockHarness.props('CaptureButton').onPress();
    mockHarness.render();
    expect(mockHarness.props('CaptureButton').disabled).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith('Photo non prise', expect.any(String), expect.any(Array));

    await mockHarness.props('CaptureButton').onPress();
    expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(2);
    mockHarness.render();
    expect(mockHarness.props('FrameOverlay').state).toBe('ready');
  });

  it.each(['resolve', 'reject'] as const)(
    'abandons a stranded Android capture and ignores its late %s while the new capture is pending',
    async (oldOutcome) => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const oldCapture = deferredCapture();
      mockHarness.render().layout().ready();
      const oldPress = mockHarness.props('CaptureButton').onPress();
      mockHarness.render();
      expect(mockHarness.props('CaptureButton').disabled).toBe(true);

      // The native view is destroyed before its capture promise settles. A new
      // view must work even when that promise never resolves or rejects.
      mockHarness.appState('background').appState('active').ready();
      expect(mockHarness.props('CaptureButton').disabled).toBe(false);
      const newCapture = deferredCapture();
      const newPress = mockHarness.props('CaptureButton').onPress();
      mockHarness.render();
      expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(2);

      if (oldOutcome === 'resolve') {
        oldCapture.resolve({ uri: 'file:///old-session.jpg', width: 1200, height: 1600 });
      } else {
        oldCapture.reject(new Error('Old camera session was destroyed'));
      }
      await oldPress;
      mockHarness.render();

      expect(Alert.alert).not.toHaveBeenCalled();
      expect(persistPendingPhoto).not.toHaveBeenCalled();
      expect(mockHarness.props('FrameOverlay').state).toBe('capturing');
      expect(mockHarness.props('CaptureButton').disabled).toBe(true);
      await mockHarness.props('CaptureButton').onPress();
      expect(mockHarness.camera.takePictureAsync).toHaveBeenCalledTimes(2);

      newCapture.resolve(undefined);
      await newPress;
      mockHarness.render();
      expect(mockHarness.props('CaptureButton').disabled).toBe(false);
      expect(mockHarness.props('FrameOverlay').state).toBe('ready');
    },
  );

  it('clears the failed-capture frame when restarting the camera', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockHarness.camera.takePictureAsync.mockRejectedValueOnce(new Error('Capture failed'));
    mockHarness.render().layout().ready();
    await mockHarness.props('CaptureButton').onPress();
    mockHarness.render();
    expect(mockHarness.props('FrameOverlay').state).toBe('error');
    const previousSession = mockHarness.find('CameraView')!.key;

    const buttons = jest.mocked(Alert.alert).mock.calls[0][2]!;
    buttons.find((button) => button.text === 'Relancer la caméra')!.onPress!();
    mockHarness.render();
    expect(mockHarness.find('CameraView')!.key).not.toBe(previousSession);
    expect(mockHarness.props('FrameOverlay').state).toBe('ready');
    expect(mockHarness.props('CaptureButton').disabled).toBe(true);
    mockHarness.ready();
    expect(mockHarness.props('FrameOverlay').state).toBe('ready');
    expect(mockHarness.props('CaptureButton').disabled).toBe(false);
  });

  it('offers system settings after permanent camera permission denial', () => {
    mockPermission = { granted: false, canAskAgain: false, status: 'denied' };
    mockHarness.render();
    expect(mockHarness.find('CameraView')).toBeUndefined();
    expect(mockRequestPermission).not.toHaveBeenCalled();

    const permissionButton = mockHarness.props('Pressable');
    expect(permissionButton.accessibilityLabel).toBe('Ouvrir les réglages');
    permissionButton.onPress();
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('refreshes iOS camera permission when returning from system settings', () => {
    Platform.OS = 'ios';
    mockPermission = { granted: false, canAskAgain: false, status: 'denied' };
    mockHarness.render();
    mockHarness.props('Pressable').onPress();
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);

    mockHarness.appState('background');
    expect(mockGetPermission).not.toHaveBeenCalled();
    mockHarness.appState('active');
    expect(mockGetPermission).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing iOS frame geometry when native layout differs from window size', () => {
    Platform.OS = 'ios';
    mockHarness.render();
    const before = mockHarness.props('FrameOverlay');
    expect(before).toEqual(expect.objectContaining({
      frameTop: 80,
      frameLeft: 10.799999999999999,
      frameWidth: 338.4,
      frameHeight: 572,
    }));

    mockHarness.tree.props.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 728 } },
    });
    mockHarness.render();
    const after = mockHarness.props('FrameOverlay');
    for (const key of ['frameTop', 'frameLeft', 'frameWidth', 'frameHeight']) {
      expect(after[key]).toBe(before[key]);
    }
  });
});
