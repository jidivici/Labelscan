// Design tokens — Elevation / Shadow
//
// Deliberately SUBTLE. A sober SaaS look leans on hairline borders + near-white
// surfaces, with shadows only as a faint lift — never the heavy "card floating off
// the page" drop shadows of the old Material spec. Cool shadow color (#0F172A).
import type { ViewStyle } from 'react-native';

type ElevationStyle = Pick<
  ViewStyle,
  'shadowColor' | 'shadowOffset' | 'shadowOpacity' | 'shadowRadius' | 'elevation'
>;

export const elevation: Record<number, ElevationStyle> = {
  0: {
    shadowOpacity: 0,
    elevation: 0,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 0,
  },
  1: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  2: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  3: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  4: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.10,
    shadowRadius: 16,
    elevation: 6,
  },
  5: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 10,
  },
};
