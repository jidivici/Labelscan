// Agent 1 — Design Spec: Spacing System (4px base grid)

// Component-specific sizing tokens (not raw magic numbers)
export const sizing = {
  captureButtonOuter: 72, // Agent 1 spec §6.2
  captureButtonInner: 56,
  captureButtonBorder: 3,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  '2xl': 48,
  '3xl': 64,
} as const;

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

export type SpacingToken = keyof typeof spacing;
export type RadiusToken = keyof typeof radius;
