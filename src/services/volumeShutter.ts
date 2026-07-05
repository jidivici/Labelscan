/**
 * volumeShutter — use the hardware volume button as a camera shutter.
 *
 * The OS exposes no "volume button pressed" event, so the standard trick is to
 * listen for VOLUME CHANGES: each physical press nudges the level, we fire the
 * shutter, then re-seat the volume mid-range (native HUD hidden) so the next press —
 * up OR down — nudges again. A short guard window ignores the change our own reset
 * causes, so it never loops.
 *
 * Requires the native module `react-native-volume-manager`, which is only present
 * after a dev-client REBUILD. The require is guarded: on a JS-only update (old native
 * binary), or in Expo Go, registration is a silent no-op — the camera still works,
 * only the volume shutter is inert until the next native build.
 */

type VolumeMgr = typeof import('react-native-volume-manager').VolumeManager;

let VolumeManager: VolumeMgr | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  VolumeManager = require('react-native-volume-manager').VolumeManager as VolumeMgr;
} catch {
  VolumeManager = null;
}

/** Whether the native volume module is linked (i.e. the dev client was rebuilt). */
export function volumeShutterAvailable(): boolean {
  return VolumeManager != null;
}

// Seat the volume mid-range so a press in EITHER direction (Volume+ OR Volume−) has
// headroom to register a change.
const RESET_LEVEL = 0.5;
// A volume report within this of RESET_LEVEL is the ECHO of our own reseat, not a real
// press — recognising it by VALUE (not just timing) is what kills the feedback loop
// reliably. A physical press moves ≥1 hardware step (~1/16 ≈ 0.0625) off 0.5, so this
// epsilon cleanly separates "our reseat" from "operator pressed".
const RESEAT_EPSILON = 0.02;
// Collapse a single physical press that the OS may report as several tiny steps into ONE
// shot (no accidental double capture).
const DEBOUNCE_MS = 300;
// Hard fallback: ignore all changes for this long right after we call setVolume, in case
// the reseat echo arrives without a usable volume value on some platforms.
const GUARD_MS = 250;

/**
 * Arm the volume-button shutter. Returns an unregister fn (call on blur/unmount) that
 * restores the native volume HUD. Safe to call when the native module is missing.
 *
 * Reliability (workflow v2): a single press = a single shot, never a loop, via three
 * independent guards — (1) VALUE check: drop the echo of our own mid-range reseat;
 * (2) a short DEBOUNCE window collapsing multi-step reports; (3) a timing GUARD while
 * setVolume settles. The caller (CameraScreen) also holds a `taking` lock.
 */
export function registerVolumeShutter(onShutter: () => void): () => void {
  const vm = VolumeManager;
  if (!vm) return () => {};

  let active = true;
  let ignoring = false; // true while our own setVolume is in flight (timing guard)
  let lastShotAt = 0;
  let sub: { remove: () => void } | null = null;

  const reseat = () => {
    ignoring = true;
    vm.setVolume(RESET_LEVEL, { showUI: false }).finally(() => {
      setTimeout(() => {
        ignoring = false;
      }, GUARD_MS);
    });
  };

  const onVolume = (result: { volume?: number } | undefined) => {
    if (!active || ignoring) return;
    const level = typeof result?.volume === 'number' ? result.volume : NaN;
    // (1) Ignore the echo of our own reseat to mid-range.
    if (!Number.isNaN(level) && Math.abs(level - RESET_LEVEL) < RESEAT_EPSILON) return;
    // (2) One press reported as several steps → fire once, but still re-center.
    const now = Date.now();
    if (now - lastShotAt < DEBOUNCE_MS) {
      reseat();
      return;
    }
    lastShotAt = now;
    onShutter();
    reseat();
  };

  try {
    // Hide the system volume HUD while the camera owns the buttons.
    vm.showNativeVolumeUI({ enabled: false });
    reseat();
    sub = vm.addVolumeListener(onVolume);
  } catch {
    // Native side not ready — leave the shutter inert.
    sub = null;
  }

  return () => {
    active = false;
    try {
      sub?.remove();
      vm.showNativeVolumeUI({ enabled: true });
    } catch {
      // ignore
    }
  };
}
