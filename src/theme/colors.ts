// Design tokens — Color
//
// Direction: sober, professional SaaS (Linear / Vercel / Stripe / Notion). A
// neutral base (white / grays / near-black) with a SINGLE, calmer blue accent.
// Color is reserved for STATE only (success / warning / error / info).
//
// The token NAMES are preserved (the old Material-You slots) so every existing
// import keeps working untouched — only the VALUES changed.
export const colors = {
  // Accent — one calmer blue for primary actions, links and active states.
  primary: '#2563EB',
  onPrimary: '#FFFFFF',
  primaryContainer: '#EAF1FE',
  onPrimaryContainer: '#1E3A8A',

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

  // Surface & background — cool near-white, separated by hairlines not heavy fills.
  background: '#F7F8FA',
  onBackground: '#18181B',
  surface: '#FFFFFF',
  onSurface: '#18181B',
  surfaceVariant: '#F1F2F4',
  onSurfaceVariant: '#6B7280',
  surfaceContainer: '#F4F5F7',
  surfaceContainerHigh: '#ECEEF1',
  outline: '#9CA3AF',
  outlineVariant: '#E6E8EC',

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
  overlayZone: 'rgba(37,99,235,0.16)',
  overlayZoneBorder: 'rgba(37,99,235,0.85)',
} as const;

export type ColorToken = keyof typeof colors;
