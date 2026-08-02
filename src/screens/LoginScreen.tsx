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

function messageForError(err: unknown): string {
  if (err instanceof Error && err.message === 'MOBILE_OPERATOR_ONLY') {
    return 'L’application mobile est réservée aux opérateurs.';
  }
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN' || err.status === 403) {
      return 'L’application mobile est réservée aux opérateurs.';
    }
    if (err.code === 'UNAUTHENTICATED' || err.status === 401) {
      return 'Identifiant ou mot de passe incorrect.';
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

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [canSubmit, signIn, username, password]);

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
            Traçabilité des produits de la mer
          </Text>
        </View>

        <View style={styles.form}>
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
            accessibilityLabel="Se connecter"
            accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={[typography.labelLarge, { color: colors.onPrimary }]}>Se connecter</Text>
            )}
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
});
