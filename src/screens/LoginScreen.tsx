/**
 * LoginScreen — username/password sign-in.
 *
 * The single gate before the app: on success the AuthContext flips to 'signedIn'
 * and the navigator renders the tabs. Errors are mapped to user-level messages
 * (no raw codes), with a distinct message for bad credentials vs. connectivity.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import { ApiError } from '../services/api';
import { colors, spacing, radius, typography, elevation } from '../theme';

type AuthMode = 'login' | 'activation';

function messageForError(err: unknown, mode: AuthMode): string {
  if (err instanceof Error && err.message === 'MOBILE_OPERATOR_ONLY') {
    return 'L’application mobile est réservée aux opérateurs.';
  }
  if (err instanceof Error && err.message === 'MOBILE_CONTEXT_MISSING') {
    return 'Ce compte opérateur n’est pas rattaché à un portail métier compatible.';
  }
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN' || err.status === 403) {
      return 'L’application mobile est réservée aux opérateurs.';
    }
    if (err.code === 'UNAUTHENTICATED' || err.status === 401) {
      return mode === 'activation'
        ? 'Ce code d’activation est invalide, expiré ou déjà utilisé.'
        : 'Identifiant ou mot de passe incorrect.';
    }
    if (err.code === 'VALIDATION_ERROR' || err.status === 422) {
      return mode === 'activation'
        ? 'Vérifiez le code et choisissez un mot de passe d’au moins 12 caractères.'
        : 'Vérifiez les informations saisies.';
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
  const { signIn, activate } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [activationToken, setActivationToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = mode === 'login'
    ? username.trim().length > 0 && password.length > 0 && !submitting
    : activationToken.trim().length > 0 &&
      newPassword.length >= 12 &&
      newPassword === confirmPassword &&
      !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'login') {
        await signIn(username.trim(), password);
      } else {
        await activate(activationToken.trim(), newPassword);
      }
      // On success the navigator swaps this screen out — no further action.
    } catch (err) {
      setError(messageForError(err, mode));
      setSubmitting(false); // keep the form mounted to show the error
    }
  }, [
    activate,
    activationToken,
    canSubmit,
    mode,
    newPassword,
    password,
    signIn,
    username,
  ]);

  const switchMode = useCallback(() => {
    setMode((current) => (current === 'login' ? 'activation' : 'login'));
    setError(null);
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.container, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.header}>
          <Image
            source={require('../../assets/labelscan-logo.png')}
            style={styles.logo}
            accessibilityLabel="Logo LabelScan"
          />
          <Text style={[typography.headlineSmall, styles.title]}>LabelScan</Text>
          <Text style={[typography.bodyMedium, styles.subtitle]}>
            Traçabilité des métiers de bouche
          </Text>
        </View>

        <View style={styles.form}>
          {mode === 'login' ? (
            <>
              <Text style={[typography.labelMedium, styles.fieldLabel]}>Identifiant</Text>
              <TextInput
                value={username}
                onChangeText={setUsername}
                style={styles.input}
                placeholder="Identifiant"
                placeholderTextColor={colors.onSurfaceVariant}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
                editable={!submitting}
                accessibilityLabel="Identifiant"
              />

              <Text style={[typography.labelMedium, styles.fieldLabel]}>Mot de passe</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                style={styles.input}
                placeholder="Mot de passe"
                placeholderTextColor={colors.onSurfaceVariant}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
                editable={!submitting}
                accessibilityLabel="Mot de passe"
              />
            </>
          ) : (
            <>
              <Text style={[typography.labelMedium, styles.fieldLabel]}>Code d’activation</Text>
              <TextInput
                value={activationToken}
                onChangeText={setActivationToken}
                style={styles.input}
                placeholder="Code remis par votre responsable"
                placeholderTextColor={colors.onSurfaceVariant}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
                editable={!submitting}
                accessibilityLabel="Code d’activation"
              />

              <Text style={[typography.labelMedium, styles.fieldLabel]}>Nouveau mot de passe</Text>
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                style={styles.input}
                placeholder="12 caractères minimum"
                placeholderTextColor={colors.onSurfaceVariant}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="next"
                editable={!submitting}
                accessibilityLabel="Nouveau mot de passe"
              />

              <Text style={[typography.labelMedium, styles.fieldLabel]}>Confirmer le mot de passe</Text>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                style={styles.input}
                placeholder="Confirmer le mot de passe"
                placeholderTextColor={colors.onSurfaceVariant}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
                editable={!submitting}
                accessibilityLabel="Confirmer le mot de passe"
              />
              {confirmPassword.length > 0 && confirmPassword !== newPassword ? (
                <Text style={[typography.bodySmall, styles.errorText]}>
                  Les mots de passe ne correspondent pas.
                </Text>
              ) : null}
            </>
          )}

          {error ? (
            <View style={styles.errorRow} accessibilityLiveRegion="polite">
              <MaterialCommunityIcons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={[typography.bodySmall, styles.errorText]}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            onPress={handleSubmit}
            disabled={!canSubmit}
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            android_ripple={{ color: colors.primaryContainer }}
            accessibilityRole="button"
            accessibilityLabel={mode === 'login' ? 'Se connecter' : 'Activer mon compte'}
            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>
                {mode === 'login' ? 'Se connecter' : 'Activer mon compte'}
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={switchMode}
            disabled={submitting}
            style={styles.modeButton}
            accessibilityRole="button"
            accessibilityLabel={
              mode === 'login' ? 'Activer un nouveau compte' : 'Revenir à la connexion'
            }
          >
            <Text style={[typography.labelMedium, styles.modeButtonText]}>
              {mode === 'login' ? 'Première connexion ? Activer mon compte' : 'J’ai déjà activé mon compte'}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing['2xl'],
  },
  logo: {
    width: 88,
    height: 88,
    borderRadius: radius.xl,
    marginBottom: spacing.lg,
    ...elevation[1],
  },
  title: {
    color: colors.onSurface,
    marginBottom: spacing.xs,
  },
  subtitle: {
    color: colors.onSurfaceVariant,
  },
  form: {
    gap: spacing.xs,
  },
  fieldLabel: {
    color: colors.onSurfaceVariant,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    ...typography.bodyLarge,
    color: colors.onSurface,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 52,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  errorText: {
    color: colors.error,
    flex: 1,
  },
  button: {
    height: 52,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
    ...elevation[2],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  modeButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  modeButtonText: {
    color: colors.primary,
    textAlign: 'center',
  },
});
