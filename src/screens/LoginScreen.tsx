/**
 * LoginScreen — username/password sign-in.
 *
 * The single gate before the app: on success the AuthContext flips to 'signedIn'
 * and the navigator renders the tabs. Errors are mapped to user-level messages
 * (no raw codes), with a distinct message for bad credentials vs. connectivity.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useAuth } from '../context/AuthContext';
import { ApiError } from '../services/api';
import { colors, spacing, radius, typography, elevation } from '../theme';

function messageForError(err: unknown): string {
  if (err instanceof Error && err.message === 'MOBILE_ACCESS_DENIED') {
    return 'Ce compte ne peut pas accéder à l’application mobile.';
  }
  if (err instanceof Error && err.message === 'MOBILE_CONTEXT_MISSING') {
    return 'Ce compte opérateur n’est pas rattaché à un portail métier compatible.';
  }
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN' || err.status === 403) {
      return 'Ce compte ne peut pas accéder à l’application mobile.';
    }
    if (err.code === 'UNAUTHENTICATED' || err.status === 401) {
      return 'Identifiant ou mot de passe incorrect.';
    }
    if (err.code === 'VALIDATION_ERROR' || err.status === 422) {
      return 'Vérifiez les informations saisies.';
    }
    if (err.code === 'CONFIG_ERROR') {
      return 'L’application n’est pas configurée pour joindre le serveur. Contactez le développeur.';
    }
    if (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT') {
      return 'Serveur injoignable. Vérifiez votre connexion et réessayez.';
    }
  }
  return 'Échec de la connexion. Réessayez.';
}

export function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const reduceMotion = useReducedMotion();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [focusedField, setFocusedField] = useState<'username' | 'password' | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logoOpacity = useSharedValue(reduceMotion ? 1 : 0);
  const logoScale = useSharedValue(reduceMotion ? 1 : 0.92);
  const logoTranslateY = useSharedValue(reduceMotion ? 0 : 8);
  const haloProgress = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;

    logoOpacity.value = withTiming(1, { duration: 280 });
    logoTranslateY.value = withTiming(0, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
    });
    logoScale.value = withSequence(
      withTiming(1.02, {
        duration: 340,
        easing: Easing.out(Easing.cubic),
      }),
      withTiming(1, {
        duration: 160,
        easing: Easing.inOut(Easing.quad),
      }),
    );
    haloProgress.value = withDelay(
      120,
      withSequence(
        withTiming(1, { duration: 360, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 520, easing: Easing.in(Easing.quad) }),
      ),
    );
  }, [haloProgress, logoOpacity, logoScale, logoTranslateY, reduceMotion]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSubscription = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const logoAnimatedStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [
      { translateY: logoTranslateY.value },
      { scale: logoScale.value },
    ],
  }));

  const haloAnimatedStyle = useAnimatedStyle(() => ({
    opacity: haloProgress.value * 0.2,
    transform: [{ scale: 0.9 + haloProgress.value * 0.2 }],
  }));

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
      // On success the navigator swaps this screen out — no further action.
    } catch (err) {
      setError(messageForError(err));
      setSubmitting(false); // keep the form mounted to show the error
    }
  }, [
    canSubmit,
    password,
    signIn,
    username,
  ]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.container,
          keyboardVisible ? styles.containerKeyboard : styles.containerCentered,
          {
            paddingTop: insets.top + (keyboardVisible ? spacing.sm : spacing.md),
            paddingBottom: insets.bottom + spacing.lg,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.formCard}>
          <View style={styles.brandRow}>
            <View style={styles.logoStage}>
              <Animated.View style={[styles.logoHalo, haloAnimatedStyle]} />
              <Animated.View style={logoAnimatedStyle}>
                <Image
                  source={require('../../assets/labelscan-logo.png')}
                  style={styles.logo}
                  accessibilityLabel="Logo LabelScan"
                />
              </Animated.View>
            </View>
            <View style={styles.brandCopy}>
              <Text style={[typography.titleLarge, styles.brandTitle]}>LabelScan</Text>
              <Text style={[typography.bodySmall, styles.brandSubtitle]}>
                Traçabilité des métiers alimentaires
              </Text>
            </View>
          </View>

          <View style={styles.brandDivider} />

          <View style={styles.formHeading}>
            <Text style={[typography.titleLarge, styles.formTitle]}>Connexion</Text>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[typography.labelMedium, styles.fieldLabel]}>Identifiant</Text>
            <View
              style={[
                styles.inputShell,
                focusedField === 'username' && styles.inputShellFocused,
              ]}
            >
              <MaterialCommunityIcons
                name="account-outline"
                size={20}
                color={focusedField === 'username' ? colors.primary : colors.onSurfaceVariant}
              />
              <TextInput
                value={username}
                onChangeText={(value) => { setUsername(value); setError(null); }}
                onFocus={() => setFocusedField('username')}
                onBlur={() => setFocusedField(null)}
                style={styles.input}
                placeholder="Votre identifiant"
                placeholderTextColor={colors.onSurfaceVariant}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                returnKeyType="next"
                editable={!submitting}
                accessibilityLabel="Identifiant"
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[typography.labelMedium, styles.fieldLabel]}>Mot de passe</Text>
            <View
              style={[
                styles.inputShell,
                focusedField === 'password' && styles.inputShellFocused,
              ]}
            >
              <MaterialCommunityIcons
                name="lock-outline"
                size={20}
                color={focusedField === 'password' ? colors.primary : colors.onSurfaceVariant}
              />
              <TextInput
                value={password}
                onChangeText={(value) => { setPassword(value); setError(null); }}
                onFocus={() => setFocusedField('password')}
                onBlur={() => setFocusedField(null)}
                style={styles.input}
                placeholder="Votre mot de passe"
                placeholderTextColor={colors.onSurfaceVariant}
                secureTextEntry={!passwordVisible}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
                editable={!submitting}
                accessibilityLabel="Mot de passe"
              />
              <Pressable
                onPress={() => setPasswordVisible((visible) => !visible)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={passwordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
              >
                <MaterialCommunityIcons
                  name={passwordVisible ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={colors.onSurfaceVariant}
                />
              </Pressable>
            </View>
          </View>

          <View style={styles.errorSlot}>
            {error ? (
              <View style={styles.errorRow} accessibilityLiveRegion="polite">
                <MaterialCommunityIcons
                  name="alert-circle-outline"
                  size={20}
                  color={colors.error}
                  style={styles.errorIcon}
                />
                <Text style={[typography.bodySmall, styles.errorText]}>{error}</Text>
              </View>
            ) : null}
          </View>

          <Pressable
            onPress={handleSubmit}
            disabled={!canSubmit}
            style={({ pressed }) => [
              styles.button,
              !canSubmit && styles.buttonDisabled,
              pressed && canSubmit && styles.buttonPressed,
            ]}
            android_ripple={{ color: colors.primaryContainer }}
            accessibilityRole="button"
            accessibilityLabel="Se connecter"
            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
                Se connecter
              </Text>
            )}
          </Pressable>
        </View>

        <View style={styles.secureRow}>
          <MaterialCommunityIcons name="shield-check-outline" size={16} color={colors.onSurfaceVariant} />
          <Text style={[typography.bodySmall, styles.secureText]}>
            Accès sécurisé à votre espace métier
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
  },
  containerCentered: {
    justifyContent: 'center',
  },
  containerKeyboard: {
    justifyContent: 'flex-start',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  logoStage: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoHalo: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
  },
  logo: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    ...elevation[1],
  },
  brandCopy: {
    flex: 1,
  },
  brandTitle: {
    color: colors.onSurface,
    marginBottom: 2,
  },
  brandSubtitle: {
    color: colors.onSurfaceVariant,
  },
  brandDivider: {
    height: 1,
    backgroundColor: colors.outlineVariant,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  formCard: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: radius.md,
    padding: spacing.lg,
    ...elevation[1],
  },
  formHeading: {
    marginBottom: spacing.md,
  },
  formTitle: {
    color: colors.onSurface,
    marginBottom: spacing.xs,
  },
  fieldGroup: {
    marginBottom: spacing.md,
  },
  fieldLabel: {
    color: colors.onSurfaceVariant,
    marginBottom: spacing.xs,
  },
  inputShell: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  inputShellFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  input: {
    ...typography.bodyLarge,
    flex: 1,
    height: '100%',
    color: colors.onSurface,
    paddingVertical: 0,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  errorSlot: {
    minHeight: 44,
  },
  errorText: {
    color: colors.error,
    flex: 1,
  },
  errorIcon: {
    marginTop: -2,
  },
  button: {
    height: 52,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    ...elevation[2],
  },
  buttonPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  secureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  secureText: {
    color: colors.onSurfaceVariant,
  },
});
