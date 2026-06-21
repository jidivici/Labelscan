/**
 * ArticleListScreen — Browse all saved articles, export, delete
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  Alert,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ArticleCard } from '../components/ArticleCard';
import { EmptyState } from '../components/EmptyState';
import { CaptureFab } from '../components/CaptureFab';
import { Article } from '../types/Article';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { getAllArticles, deleteArticle } from '../services/storage';
import { exportAsJSON, exportAsCSV } from '../services/export';
import { useArticleSearch } from '../hooks/useArticleSearch';
import { sortArticlesByName } from '../services/articleGrouping';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, radius, typography, elevation } from '../theme';

export function ArticleListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const { signOut } = useAuth();
  const [articles, setArticles] = useState<Article[]>([]);
  const [exporting, setExporting] = useState(false);
  // Omni-search: lot, espèce, zone FAO, élevage, fournisseur… (services/articleSearch).
  const { query, setQuery, results } = useArticleSearch(articles);
  // Accueil : arrivages triés par nom de produit (A→Z).
  const ordered = useMemo(() => sortArticlesByName(results), [results]);

  // Reload whenever screen comes into focus (after a save)
  useFocusEffect(
    useCallback(() => {
      loadArticles();
    }, [])
  );

  const loadArticles = async () => {
    const data = await getAllArticles();
    setArticles(data);
  };

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteArticle(id);
      setArticles((prev) => prev.filter((a) => a.id !== id));
    } catch {
      Alert.alert('Erreur', 'Impossible de supprimer l’article.');
    }
  }, []);

  const handleExportJSON = useCallback(async () => {
    if (articles.length === 0) {
      Alert.alert('Rien à exporter', 'Enregistrez d’abord des articles.');
      return;
    }
    setExporting(true);
    try {
      await exportAsJSON(articles);
    } catch (err) {
      Alert.alert('Échec de l’export', 'Vérifiez l’espace disponible et réessayez.');
    } finally {
      setExporting(false);
    }
  }, [articles]);

  const handleExportCSV = useCallback(async () => {
    if (articles.length === 0) {
      Alert.alert('Rien à exporter', 'Enregistrez d’abord des articles.');
      return;
    }
    setExporting(true);
    try {
      await exportAsCSV(articles);
    } catch {
      Alert.alert('Échec de l’export', 'Vérifiez l’espace disponible et réessayez.');
    } finally {
      setExporting(false);
    }
  }, [articles]);

  const showExportOptions = useCallback(() => {
    Alert.alert(
      'Exporter les articles',
      `Exporter les ${articles.length} article${articles.length !== 1 ? 's' : ''}`,
      [
        { text: 'JSON', onPress: handleExportJSON },
        { text: 'CSV', onPress: handleExportCSV },
        { text: 'Annuler', style: 'cancel' },
      ]
    );
  }, [articles.length, handleExportJSON, handleExportCSV]);

  // Open the capture module (camera mounts on entry, unmounts when popped).
  const openCapture = useCallback(() => {
    navigation.navigate('Camera');
  }, [navigation]);

  const handleSignOut = useCallback(() => {
    Alert.alert('Déconnexion', 'Se déconnecter de LabelScan ?', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Se déconnecter', style: 'destructive', onPress: () => { void signOut(); } },
    ]);
  }, [signOut]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* App bar */}
      <View style={styles.appBar}>
        <Text style={[typography.titleLarge, { color: colors.onSurface }]}>
          Articles
        </Text>
        <View style={styles.appBarActions}>
          {articles.length > 0 && (
            <Pressable
              onPress={showExportOptions}
              disabled={exporting}
              style={styles.iconButton}
              android_ripple={{ color: colors.primaryContainer, borderless: true }}
              accessibilityRole="button"
              accessibilityLabel="Exporter les articles"
              accessibilityState={{ disabled: exporting }}
            >
              <MaterialCommunityIcons
                name="export-variant"
                size={22}
                color={exporting ? colors.onSurfaceVariant : colors.primary}
              />
            </Pressable>
          )}
          <Pressable
            onPress={handleSignOut}
            style={styles.iconButton}
            android_ripple={{ color: colors.primaryContainer, borderless: true }}
            accessibilityRole="button"
            accessibilityLabel="Se déconnecter"
          >
            <MaterialCommunityIcons name="logout" size={22} color={colors.onSurfaceVariant} />
          </Pressable>
        </View>
      </View>

      {/* Recherche par lot */}
      {articles.length > 0 && (
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <MaterialCommunityIcons name="magnify" size={20} color={colors.onSurfaceVariant} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Rechercher : lot, espèce, zone FAO…"
              placeholderTextColor={colors.onSurfaceVariant}
              style={[typography.bodyMedium, styles.searchInput]}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Rechercher un produit"
            />
            {query.length > 0 ? (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Effacer la recherche"
              >
                <MaterialCommunityIcons name="close-circle" size={18} color={colors.onSurfaceVariant} />
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {/* List — sorted by product name */}
      <FlatList
        data={ordered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ArticleCard
            article={item}
            onDelete={handleDelete}
            onOpen={(a) => navigation.navigate('ArticleDetail', { articleId: a.id })}
          />
        )}
        contentContainerStyle={[
          styles.listContent,
          // Extra bottom space so the FAB never covers the last card.
          { paddingBottom: insets.bottom + spacing['3xl'] + 72 },
        ]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          articles.length === 0 ? (
            <EmptyState onCapture={openCapture} />
          ) : (
            <View style={styles.noResults}>
              <MaterialCommunityIcons name="magnify-close" size={40} color={colors.onSurfaceVariant} />
              <Text style={[typography.bodyMedium, styles.noResultsText]}>
                Aucun résultat pour « {query.trim()} ».
              </Text>
            </View>
          )
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Launches the capture module (bottom-right). */}
      <CaptureFab onPress={openCapture} bottomInset={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  appBar: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    ...elevation[2],
  },
  appBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingTop: spacing.sm,
  },
  searchRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceContainer,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  searchInput: {
    flex: 1,
    color: colors.onSurface,
    paddingVertical: 0,
  },
  noResults: {
    alignItems: 'center',
    paddingTop: spacing['2xl'],
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  noResultsText: {
    color: colors.onSurfaceVariant,
    textAlign: 'center',
  },
});
