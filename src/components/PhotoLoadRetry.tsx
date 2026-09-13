import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, spacing, typography } from '../theme';

/** Android download failures can be retried without reopening the saved arrival. */
export function PhotoLoadRetry({ onRetry, compact = false }: { onRetry: () => void; compact?: boolean }) {
  return (
    <Pressable
      style={styles.retry}
      onPress={(event) => {
        event.stopPropagation();
        onRetry();
      }}
      accessibilityRole="button"
      accessibilityLabel="Réessayer de charger la photo"
    >
      <MaterialCommunityIcons name="image-refresh-outline" size={compact ? 26 : 30} color={colors.primary} />
      {!compact ? <Text style={[typography.labelMedium, styles.text]}>Photo indisponible</Text> : null}
      <Text style={[typography.labelSmall, styles.text]}>Réessayer</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  retry: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  text: { color: colors.primary, textAlign: 'center' },
});
