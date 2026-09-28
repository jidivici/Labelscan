import { AppState } from 'react-native';

import { dayKey, millisecondsUntilNextLocalMidnight } from './calendar';

/**
 * Emit the local day at subscription, at midnight and on foreground resume.
 * Recheck at most once a minute while active to handle clock/time-zone changes.
 * No background timer or network access: suspended apps catch up on resume.
 */
export function watchLocalDay(onDay: (day: string) => void): () => void {
  let lastDay = '';
  let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const check = () => {
    if (disposed) return;
    clearTimer();
    const now = new Date();
    const day = dayKey(now.toISOString());
    if (day !== lastDay) {
      lastDay = day;
      onDay(day);
    }
    if (active) {
      timer = setTimeout(check, Math.max(1, Math.min(60_000, millisecondsUntilNextLocalMidnight(now))));
    }
  };
  const subscription = AppState.addEventListener('change', (state) => {
    active = state === 'active';
    if (active) check();
    else clearTimer();
  });
  check();

  return () => {
    disposed = true;
    clearTimer();
    subscription.remove();
  };
}
