import { AppState } from 'react-native';

import { useArrivalDay } from '../hooks/useArrivalDay';
import { millisecondsUntilNextLocalMidnight } from '../services/calendar';
import { watchLocalDay } from '../services/localDayClock';

const mockListeners = new Set<(state: string) => void>();
let mockState: { today: string; selectedDay: string } | undefined;
let mockEffectMounted = false;
let mockCleanup: (() => void) | undefined;

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mockListeners.add(listener);
      return { remove: () => mockListeners.delete(listener) };
    },
  },
}));
// Minimal state/effect host; exercise the real hook and real clock subscription.
jest.mock('react', () => ({
  useState: (initial: () => typeof mockState) => {
    if (mockState === undefined) mockState = initial();
    return [mockState, (update: (previous: typeof mockState) => typeof mockState) => {
      mockState = update(mockState);
    }];
  },
  useEffect: (effect: () => () => void) => {
    if (mockEffectMounted) return;
    mockEffectMounted = true;
    mockCleanup = effect();
  },
  useCallback: (callback: unknown) => callback,
}));

function appState(state: 'active' | 'background' | 'inactive') {
  AppState.currentState = state;
  for (const listener of mockListeners) listener(state);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 8, 28, 23, 59, 59, 750));
  AppState.currentState = 'active';
  mockListeners.clear();
  mockState = undefined;
  mockEffectMounted = false;
  mockCleanup = undefined;
});

afterEach(() => {
  mockCleanup?.();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('changes to the new day at local midnight without another user action', () => {
  const changed = jest.fn();
  const stop = watchLocalDay(changed);
  expect(changed).toHaveBeenLastCalledWith('2026-09-28');
  jest.advanceTimersByTime(249);
  expect(changed).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1);
  expect(changed).toHaveBeenLastCalledWith('2026-09-29');
  jest.advanceTimersByTime(60_000);
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
  expect(jest.getTimerCount()).toBe(0);
  expect(mockListeners.size).toBe(0);
});

it('catches up immediately after several suspended days with no background timer', () => {
  const changed = jest.fn();
  const stop = watchLocalDay(changed);
  appState('background');
  expect(jest.getTimerCount()).toBe(0);
  jest.setSystemTime(new Date(2026, 9, 2, 7));
  appState('active');
  expect(changed.mock.calls.map(([day]) => day)).toEqual(['2026-09-28', '2026-10-02']);
  appState('active');
  expect(changed).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(1);
  stop();
});

it('detects wall-clock corrections while active and cancels everything on unmount', () => {
  const changed = jest.fn();
  const stop = watchLocalDay(changed);
  jest.setSystemTime(new Date(2026, 9, 1, 9));
  jest.advanceTimersByTime(60_000);
  expect(changed).toHaveBeenLastCalledWith('2026-10-01');
  stop();
  jest.setSystemTime(new Date(2026, 9, 2, 9));
  appState('active');
  jest.advanceTimersByTime(60_000);
  expect(changed).toHaveBeenCalledTimes(2);
});

it('starts on today, keeps same-day historical browsing, resets that choice next day', () => {
  expect(useArrivalDay().selectedDay).toBe('2026-09-28');
  useArrivalDay().setSelectedDay('2026-09-20');
  appState('inactive');
  appState('active');
  expect(useArrivalDay().selectedDay).toBe('2026-09-20');
  jest.advanceTimersByTime(250);
  expect(useArrivalDay()).toMatchObject({ today: '2026-09-29', selectedDay: '2026-09-29' });
});

it('starts on the right day after a cold launch following a long shutdown', () => {
  jest.setSystemTime(new Date(2027, 0, 1, 8));
  expect(useArrivalDay()).toMatchObject({ today: '2027-01-01', selectedDay: '2027-01-01' });
});

it.each([
  [2026, 11, 31, '2027-01-01'],
  [2028, 1, 28, '2028-02-29'],
  [2026, 2, 29, '2026-03-30'],
  [2026, 9, 25, '2026-10-26'],
])('uses calendar midnight across month/year/leap/DST boundaries (%s-%s-%s)', (year, month, day, key) => {
  const now = new Date(Number(year), Number(month), Number(day));
  const next = new Date(now.getTime() + millisecondsUntilNextLocalMidnight(now));
  expect(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`).toBe(key);
  expect(next.getHours()).toBe(0);
  const hours = 24 + (next.getTimezoneOffset() - now.getTimezoneOffset()) / 60;
  expect(millisecondsUntilNextLocalMidnight(now)).toBe(hours * 3_600_000);
});
