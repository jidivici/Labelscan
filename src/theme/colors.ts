// Design tokens — Color
//
// Direction: sober, professional food traceability. A neutral, slightly warm base
// with a SINGLE ocean-green accent that recalls freshness without becoming loud.
// Color is reserved for STATE only (success / warning / error / info).
//
// The token NAMES are preserved (the old Material-You slots) so every existing
// import keeps working untouched — only the VALUES changed.
export const colors = {
  // Accent — the original LabelScan green for primary actions and active states.
  primary: '#087F72',
  onPrimary: '#FFFFFF',
  primaryContainer: '#DDF4EF',
  onPrimaryContainer: '#07554E',

  // Secondary = neutral gray (subtle "à compléter" tags, highlighted inputs) —
  // deliberately NOT a second brand color, so the UI stays monochrome + 1 accent.
  secondary: '#64748B',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#EFF1F4',
  onSecondaryContainer: '#334155',

  // Tertiary (kept neutral; barely used — never a third loud color).
  tertiary: '#64748B',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#EFF1F4',
  onTertiaryContainer: '#334155',

  // Surface & background — quiet near-white, separated by hairlines not heavy fills.
  background: '#F4F7F5',
  onBackground: '#152622',
  surface: '#FFFFFF',
  onSurface: '#152622',
  surfaceVariant: '#EEF3F1',
  onSurfaceVariant: '#60706C',
  surfaceContainer: '#F1F5F3',
  surfaceContainerHigh: '#E7EFEC',
  outline: '#93A39F',
  outlineVariant: '#DDE7E3',

  // Semantic — used ONLY to signal a state (vert=succès, orange=attente,
  // rouge=erreur, bleu=info), never for decoration.
  error: '#DC2626',
  onError: '#FFFFFF',
  errorContainer: '#FEE2E2',
  onErrorContainer: '#7F1D1D',
  success: '#15803D',
  onSuccess: '#FFFFFF',
  successContainer: '#E7F5EC',
  onSuccessContainer: '#14532D',
  warning: '#D97706',
  onWarning: '#FFFFFF',
  warningContainer: '#FEF3C7',
  onWarningContainer: '#92400E',
  info: '#2563EB',
  infoContainer: '#EAF1FE',
  onInfoContainer: '#1E3A8A',

  // Overlay / Scrim
  scrim: 'rgba(0,0,0,0.32)',
  overlayZone: 'rgba(8,127,114,0.16)',
  overlayZoneBorder: 'rgba(8,127,114,0.88)',
} as const;
