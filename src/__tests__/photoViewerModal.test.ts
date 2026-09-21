import * as React from 'react';
import { Platform } from 'react-native';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => mockHarness.useState(initial),
  useEffect: (effect: () => void, dependencies: unknown[]) => mockHarness.useEffect(effect, dependencies),
}));
jest.mock('react-native', () => ({
  Modal: 'Modal',
  StatusBar: 'StatusBar',
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => mockWindowSize,
}));
jest.mock('react-native-gesture-handler', () => {
  const gesture = (kind: string) => ({
    kind,
    update: undefined as unknown,
    end: undefined as unknown,
    onUpdate(callback: unknown) { this.update = callback; return this; },
    onEnd(callback: unknown) { this.end = callback; return this; },
    numberOfTaps() { return this; },
  });
  return {
    GestureHandlerRootView: 'GestureRoot',
    GestureDetector: 'GestureDetector',
    Gesture: {
      Pinch: () => gesture('pinch'),
      Pan: () => gesture('pan'),
      Tap: () => gesture('tap'),
      Simultaneous: (...gestures: unknown[]) => ({ gestures }),
      Race: (...gestures: unknown[]) => ({ gestures }),
    },
  };
});
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { Image: 'AnimatedImage' },
  useSharedValue: (value: number) => mockHarness.useSharedValue(value),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withTiming: (value: number) => value,
}));
jest.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));
jest.mock('../theme', () => ({ colors: { onPrimary: '#fff' }, spacing: { sm: 8, md: 16 } }));

import { PhotoViewerModal, type PhotoViewerModalProps } from '../components/PhotoViewerModal';

type TestElement = React.ReactElement<Record<string, any>>;
let mockWindowSize = { width: 360, height: 776 };
let mockHarness: ViewerHarness;

/** Exercise the actual modal props and native onLayout callback without a native renderer. */
class ViewerHarness {
  private slots: any[] = [];
  private cursor = 0;
  tree!: TestElement;
  props: PhotoViewerModalProps = {
    visible: true,
    photoUri: 'file:///photos/label.jpg',
    baseRotationDegrees: 0,
    onClose: jest.fn(),
  };

  useState(initial: unknown) {
    const slot = this.cursor++;
    if (!(slot in this.slots)) this.slots[slot] = initial;
    return [this.slots[slot], (next: any) => {
      this.slots[slot] = typeof next === 'function' ? next(this.slots[slot]) : next;
    }];
  }

  useSharedValue(value: number) {
    const slot = this.cursor++;
    if (!(slot in this.slots)) this.slots[slot] = { value };
    return this.slots[slot];
  }

  useEffect(effect: () => void, dependencies: unknown[]) {
    const slot = this.cursor++;
    const previous = this.slots[slot];
    if (previous?.length === dependencies.length && previous.every((value: unknown, index: number) =>
      Object.is(value, dependencies[index]))) return;
    this.slots[slot] = dependencies;
    effect();
  }

  render() {
    this.cursor = 0;
    this.tree = PhotoViewerModal(this.props)!;
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

  nativeProps(type: string) {
    const element = this.find(type);
    if (!element) throw new Error(`Expected ${type}`);
    return element.props;
  }

  layout(width: number, height: number) {
    this.nativeProps('GestureRoot').onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
    return this.render();
  }

  imageStyle() {
    return Object.assign({}, ...this.nativeProps('AnimatedImage').style);
  }
}

describe('PhotoViewerModal Android coverage and iOS preservation', () => {
  beforeEach(() => {
    Platform.OS = 'android';
    mockWindowSize = { width: 360, height: 776 };
    mockHarness = new ViewerHarness();
  });

  it('covers both system bar regions with an opaque black Android dialog', () => {
    mockHarness.render();
    expect(mockHarness.nativeProps('Modal')).toEqual(expect.objectContaining({
      visible: true,
      transparent: false,
      backdropColor: '#000',
      statusBarTranslucent: true,
      navigationBarTranslucent: true,
      animationType: 'fade',
    }));
    expect(mockHarness.nativeProps('GestureRoot').style).toEqual({ flex: 1, backgroundColor: '#000' });
    mockHarness.nativeProps('Modal').onRequestClose();
    expect(mockHarness.props.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, false, '0deg'],
    [0, true, '180deg'],
    [-90, false, '-90deg'],
    [-90, true, '90deg'],
  ] as const)('contains the entire photo using measured modal bounds (base %s, half-turn %s)', (base, halfTurn, rotation) => {
    mockHarness.props.baseRotationDegrees = base;
    mockHarness.props.halfTurn = halfTurn;
    mockHarness.render().layout(360, 824);
    expect(mockHarness.nativeProps('AnimatedImage').resizeMode).toBe('contain');
    const style = mockHarness.imageStyle();
    expect(style).toEqual(expect.objectContaining(base === -90
      ? { left: -232, top: 232, width: 824, height: 360 }
      : { left: 0, top: 0, width: 360, height: 824 }));
    expect(style.transform).toEqual([
      { translateX: 0 }, { translateY: 0 },
      ...(rotation === '0deg' ? [] : [{ rotate: rotation }]),
      { scale: 1 },
    ]);
  });

  it('updates for an Android modal resize and ignores unusable layout events', () => {
    mockHarness.render().layout(360, 824);
    // Zooming still works; changing the modal viewport returns the full image to contain.
    mockHarness.nativeProps('GestureDetector').gesture.gestures[0].end();
    mockHarness.render();
    expect(mockHarness.imageStyle().transform).toContainEqual({ scale: 2.5 });
    mockHarness.layout(824, 360);
    expect(mockHarness.imageStyle()).toEqual(expect.objectContaining({ width: 824, height: 360 }));
    expect(mockHarness.imageStyle().transform).toContainEqual({ scale: 1 });
    mockHarness.layout(0, 0).layout(Number.NaN, 360);
    expect(mockHarness.imageStyle()).toEqual(expect.objectContaining({ width: 824, height: 360 }));
  });

  it('preserves iOS modal props, window geometry and safe close-button placement', () => {
    Platform.OS = 'ios';
    mockHarness.props.baseRotationDegrees = -90;
    mockHarness.render();
    const modal = mockHarness.nativeProps('Modal');
    expect(modal.transparent).toBe(true);
    expect(modal.animationType).toBe('fade');
    expect(modal).not.toHaveProperty('statusBarTranslucent');
    expect(modal).not.toHaveProperty('navigationBarTranslucent');
    expect(modal).not.toHaveProperty('backdropColor');
    expect(mockHarness.nativeProps('GestureRoot').onLayout).toBeUndefined();
    mockHarness.layout(360, 824);
    expect(mockHarness.imageStyle()).toEqual(expect.objectContaining({
      left: -208, top: 208, width: 776, height: 360,
    }));
    expect(mockHarness.nativeProps('Pressable').style).toContainEqual({ top: 32 });
    expect(mockHarness.nativeProps('AnimatedImage').resizeMode).toBe('contain');
  });

  it('forwards decoder failures to the existing retry path', () => {
    const onImageError = jest.fn();
    mockHarness.props.onImageError = onImageError;
    mockHarness.render();
    const error = { nativeEvent: { error: 'Could not decode image' } };
    mockHarness.nativeProps('AnimatedImage').onError(error);
    expect(onImageError).toHaveBeenCalledWith(error);
  });
});
