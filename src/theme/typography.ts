// Agent 1 — Design Spec: Typography Scale (Inter font)
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';

export const fonts = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
};

export const typography = {
  headlineLarge: {
    fontFamily: 'Inter_400Regular',
    fontSize: 32,
    lineHeight: 40,
    letterSpacing: 0,
  },
  headlineMedium: {
    fontFamily: 'Inter_400Regular',
    fontSize: 28,
    lineHeight: 36,
    letterSpacing: 0,
  },
  headlineSmall: {
    fontFamily: 'Inter_400Regular',
    fontSize: 24,
    lineHeight: 32,
    letterSpacing: 0,
  },
  titleLarge: {
    fontFamily: 'Inter_500Medium',
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: 0,
  },
  titleMedium: {
    fontFamily: 'Inter_500Medium',
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0.15,
  },
  titleSmall: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.1,
  },
  bodyLarge: {
    fontFamily: 'Inter_400Regular',
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: 0.15,
  },
  bodyMedium: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.25,
  },
  bodySmall: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
  },
  labelLarge: {
    fontFamily: 'Inter_500Medium',
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.1,
  },
  labelMedium: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.5,
  },
  labelSmall: {
    fontFamily: 'Inter_500Medium',
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.5,
  },
} as const;

export type TypographyToken = keyof typeof typography;
