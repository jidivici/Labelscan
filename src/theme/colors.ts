// Agent 1 — Design Spec: Color Tokens (Material You Light)
export const colors = {
  // Primary
  primary: '#1B6EF3',
  onPrimary: '#FFFFFF',
  primaryContainer: '#D8E6FF',
  onPrimaryContainer: '#001945',

  // Secondary
  secondary: '#565F71',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#DAE2F9',
  onSecondaryContainer: '#131C2C',

  // Tertiary
  tertiary: '#715573',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#FCD7FC',
  onTertiaryContainer: '#29132C',

  // Surface & Background
  background: '#F8F9FF',
  onBackground: '#191C20',
  surface: '#FFFFFF',
  onSurface: '#191C20',
  surfaceVariant: '#E1E2EC',
  onSurfaceVariant: '#44474F',
  surfaceContainer: '#ECEDF4',
  surfaceContainerHigh: '#E6E8EF',
  outline: '#74777F',
  outlineVariant: '#C4C6D0',

  // Semantic
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  success: '#1A6B3C',
  successContainer: '#C6F2D8',

  // Overlay / Scrim
  scrim: 'rgba(0,0,0,0.32)',
  overlayZone: 'rgba(27,110,243,0.20)',
  overlayZoneBorder: 'rgba(27,110,243,0.85)',
} as const;

export type ColorToken = keyof typeof colors;
