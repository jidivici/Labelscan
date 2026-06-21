// Agent 1 — Design Spec: Elevation / Shadow tokens
import type { ViewStyle } from 'react-native';

type ElevationStyle = Pick<
  ViewStyle,
  'shadowColor' | 'shadowOffset' | 'shadowOpacity' | 'shadowRadius' | 'elevation'
>;

export const elevation: Record<number, ElevationStyle> = {
  0: {
    shadowOpacity: 0,
    elevation: 0,
    shadowColor: '#191C20',
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 0,
  },
  1: {
    shadowColor: '#191C20',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  2: {
    shadowColor: '#191C20',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.10,
    shadowRadius: 4,
    elevation: 3,
  },
  3: {
    shadowColor: '#191C20',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 6,
  },
  4: {
    shadowColor: '#191C20',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
    elevation: 8,
  },
  5: {
    shadowColor: '#191C20',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.20,
    shadowRadius: 14,
    elevation: 12,
  },
};
