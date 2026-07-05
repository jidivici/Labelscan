/**
 * ArticleListScreen — the app's home: browse every saved lot, search, export, capture.
 *
 * Branded header (LabelScan / Articles) with a compact action cluster: the omni-search
 * lives in the header as an icon button that SLIDES a search bar open (homogeneous with
 * export + sign-out), rather than taking a permanent row. The list is sorted by product
 * name; capture is the bottom-right FAB.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  Alert,
  TextInput,
  Animated,
  LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { ArticleCard, CARD_HEIGHT } from '../components/ArticleCard';
import { EmptyState } from '../components/EmptyState';
import { CaptureFab } from '../components/CaptureFab';
import { PendingScanCard } from '../components/PendingScanCard';
import { Article } from '../types/Article';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { getAllArticles, deleteArticle } from '../services/storage';
import { exportAsJSON, exportAsCSV } from '../services/export';
import { useArticleSearch } from '../hooks/useArticleSearch';
import { useScanQueue } from '../hooks/useScanQueue';
import { discardScan, retryScan, type PendingScan } from '../services/scanQueue';
import {
  filledCountFromInterim,
  filledCountFromRun,
  isProductNameKnownFromInterim,
  isProductNameKnownFromRun,
} from '../services/fieldCompleteness';
import { sortArticlesByName } from '../services/articleGrouping';
import { useAuth } from '../context/AuthContext';
import { colors, spacing, radius, typography } from '../theme';

// Each card has a FIXED height (CARD_HEIGHT) + its marginBottom, so FlatList can place
// rows without measuring them — O(1) scroll at thousands of lots (audit §7.1). The
// "En cours" section sits in ListHeaderComponent above them; getItemLayout adds its
// MEASURED height (via onLayout, not hardcoded — PendingScanCard/section-title styling
// can change without this offset math silently drifting) as a constant offset.
const ITEM_HEIGHT = CARD_HEIGHT + spacing.sm;

// Height the search bar expands to when it slides open (box + vertical padding).
const SEARCH_OPEN_HEIGHT = 44 + spacing.sm * 2;

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

  // "En cours" (workflow v1): scans queued by the camera, tracked across screens by
  // the scan queue. Rendered as the FlatList's header so there's one scroll surface;
  // its MEASURED height (not hardcoded) keeps getItemLayout exact for the articles
  // below it (audit §7.1 — O(1) scroll). The full snapshot (results + interim) drives
  // the "n/17 champs" text + the "name known" highlight on each card.
  const { scans: pendingScans, results: scanResults, interim: scanInterim } = useScanQueue();
  const [pendingHeaderHeight, setPendingHeaderHeight] = useState(0);
  useEffect(() => {
    if (pendingScans.length === 0) setPendingHeaderHeight(0);
  }, [pendingScans.length]);
  const handlePendingHeaderLayout = useCallback((e: LayoutChangeEvent) => {
    setPendingHeaderHeight(e.nativeEvent.layout.height);
  }, []);
  const getItemLayout = useCallback(
    (_data: ArrayLike<Article> | null | undefined, index: number) => ({
      length: ITEM_HEIGHT,
      offset: pendingHeaderHeight + ITEM_HEIGHT * index,
      index,
    }),
    [pendingHeaderHeight],
  );

  const handleOpenScan = useCallback(
    (scan: PendingScan) => navigation.navigate('Review', { pendingScanId: scan.id }),
    [navigation],
  );
  const handleRetryScan = useCallback((id: string) => {
    void retryScan(id);
  }, []);
  const handleDiscardScan = useCallback((id: string) => {
    void discardScan(id);
  }, []);

  const pendingHeader = useMemo(() => {
    if (pendingScans.length === 0) return null;
    return (
      <View onLayout={handlePendingHeaderLayout}>
        <Text style={[typography.labelMedium, styles.pendingTitle]}>
          {`En cours (${pendingScans.length})`}
        </Text>
        {pendingScans.map((scan) => {
          // /17 score + name-known probe: prefer the FINAL run when ready, else the
          // Tier-3 interim preview (while extracting); submitting scans show 0/17.
          // The scan's persisted review draft (edits) OVERLAYS both, so the gauge
          // advances live as the operator fills fields across review sessions.
          const result = scanResults[scan.id];
          const interimValues = scanInterim[scan.id];
          const filledCount = result?.run
            ? filledCountFromRun(result.run.fields, scan.edits)
            : filledCountFromInterim(interimValues, scan.edits);
          const nameKnown = result?.run
            ? isProductNameKnownFromRun(result.run.fields, scan.edits)
            : isProductNameKnownFromInterim(interimValues, scan.edits);
          return (
            <PendingScanCard
              key={scan.id}
              scan={scan}
              filledCount={filledCount}
              nameKnown={nameKnown}
              onOpen={handleOpenScan}
              onRetry={handleRetryScan}
              onDiscard={handleDiscardScan}
            />
          );
        })}
      </View>
    );
  }, [
    pendingScans,
    scanResults,
    scanInterim,
    handlePendingHeaderLayout,
    handleOpenScan,
    handleRetryScan,
    handleDiscardScan,
  ]);

  // Search slides open from the header (homogeneous with the other actions).
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    Animated.timing(searchAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: false,
    }).start();
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchAnim]);

  const closeSearch = useCallback(() => {
    searchInputRef.current?.blur();
    setQuery('');
    Animated.timing(searchAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: false,
    }).start(() => setSearchOpen(false));
  }, [searchAnim, setQuery]);

  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch();
    else openSearch();
  }, [searchOpen, openSearch, closeSearch]);

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

  // Stable callbacks + renderItem so React.memo(ArticleCard) actually skips unchanged rows.
  const handleOpen = useCallback(
    (a: Article) => navigation.navigate('ArticleDetail', { articleId: a.id }),
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: Article }) => (
      <ArticleCard article={item} onDelete={handleDelete} onOpen={handleOpen} />
    ),
    [handleDelete, handleOpen],
  );

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

  const hasArticles = articles.length > 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Branded app bar */}
      <View style={styles.appBar}>
        <View style={styles.brand}>
          <View style={styles.brandMark}>
            <MaterialCommunityIcons name="barcode-scan" size={20} color={colors.onPrimary} />
          </View>
          <View style={styles.brandText}>
            <Text style={[typography.titleLarge, styles.brandTitle]}>LabelScan</Text>
            <Text style={[typography.labelSmall, styles.brandSubtitle]}>Articles</Text>
          </View>
        </View>

        <View style={styles.appBarActions}>
          {hasArticles && (
            <Pressable
              onPress={toggleSearch}
              style={[styles.iconButton, searchOpen && styles.iconButtonActive]}
              android_ripple={{ color: colors.primaryContainer, borderless: true }}
              accessibilityRole="button"
              accessibilityLabel={searchOpen ? 'Fermer la recherche' : 'Rechercher'}
              accessibilityState={{ expanded: searchOpen }}
            >
              <MaterialCommunityIcons
                name={searchOpen ? 'close' : 'magnify'}
                size={22}
                color={searchOpen ? colors.primary : colors.onSurfaceVariant}
              />
            </Pressable>
          )}
          {hasArticles && (
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

      {/* Slide-open search (driven by the header search button) */}
      {hasArticles && (
        <Animated.View
          style={[
            styles.searchSlide,
            {
              height: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, SEARCH_OPEN_HEIGHT] }),
              opacity: searchAnim,
            },
          ]}
        >
          <View style={styles.searchRow}>
            <View style={styles.searchBox}>
              <MaterialCommunityIcons name="magnify" size={20} color={colors.onSurfaceVariant} />
              <TextInput
                ref={searchInputRef}
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
        </Animated.View>
      )}

      {/* List — sorted by product name */}
      <FlatList
        data={ordered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ListHeaderComponent={pendingHeader}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
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
  // Sober header: a hairline separator instead of a drop shadow (Linear/Vercel).
  appBar: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  // ── Brand ────────────────────────────────────────────────────────────────────
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  brandMark: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: {
    flexShrink: 1,
  },
  brandTitle: {
    color: colors.onSurface,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  brandSubtitle: {
    color: colors.onSurfaceVariant,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 1,
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
  iconButtonActive: {
    backgroundColor: colors.primaryContainer,
  },
  // ── Slide-open search ──────────────────────────────────────────────────────────
  searchSlide: {
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  searchRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
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
  listContent: {
    paddingTop: spacing.md,
  },
  pendingTitle: {
    color: colors.onSurfaceVariant,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
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
