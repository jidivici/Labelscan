/**
 * ArticleListScreen — the app's home: browse the selected day's lots, search, export,
 * capture.
 *
 * Branded header (LabelScan / Articles) with a compact action cluster: the calendar
 * and the omni-search live in the header as icon buttons that SLIDE a panel open
 * (homogeneous with export + sign-out), rather than taking a permanent row.
 *
 * The list opens on today's arrivals. The calendar selects another day; omni-search
 * intentionally remains global. Articles are sorted by product name; capture is the
 * bottom-right FAB.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  Alert,
  TextInput,
  Animated,
  Image,
  LayoutChangeEvent,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { ArticleCard, CARD_HEIGHT } from '../components/ArticleCard';
import { CalendarPanel } from '../components/CalendarPanel';
import { EmptyState } from '../components/EmptyState';
import { CaptureFab } from '../components/CaptureFab';
import { PendingScanCard } from '../components/PendingScanCard';
import { Article } from '../types/Article';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useCatalogArticles } from '../services/catalogApi';
import { exportAsJSON, exportAsCSV } from '../services/export';
import { useArticleSearch } from '../hooks/useArticleSearch';
import { useScanQueue } from '../hooks/useScanQueue';
import { sortPendingScansNewestFirst } from '../services/pendingScanOrder';
import { discardScan, retryScan, type PendingScan } from '../services/scanQueue';
import {
  filledCountFromInterim,
  filledCountFromRun,
  isProductNameKnownFromInterim,
  isProductNameKnownFromRun,
} from '../services/fieldCompleteness';
import { sortArticlesByName } from '../services/articleGrouping';
import { countByDay, dayKey, formatDayKey, todayKey } from '../services/calendar';
import { useAuth } from '../context/AuthContext';
import { businessProfileFor } from '../services/businessProfiles';
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
  const { signOut, businessPortalId, tradeCode, businessProfile } = useAuth();
  const { data: articles = [], refetch, isRefetching } = useCatalogArticles();
  const [exporting, setExporting] = useState(false);
  // Omni-search: lot, espèce, zone FAO, élevage, fournisseur… (services/articleSearch).
  const { query, setQuery, results } = useArticleSearch(articles);
  const searching = query.trim().length > 0;

  // The home list is day-scoped, starting on today. Search intentionally remains
  // global across the operator's permitted store.
  const [selectedDay, setSelectedDay] = useState<string>(() => todayKey());
  const dayCounts = useMemo(() => countByDay(articles), [articles]);
  const dayScoped = useMemo(
    () => (searching ? results : results.filter((a) => dayKey(a.saved_at) === selectedDay)),
    [results, searching, selectedDay],
  );
  // Accueil : arrivages de la journée triés par nom de produit (A→Z).
  const ordered = useMemo(() => sortArticlesByName(dayScoped), [dayScoped]);

  // "En cours" (workflow v1): scans queued by the camera, tracked across screens by
  // the scan queue. Rendered as the FlatList's header so there's one scroll surface;
  // its MEASURED height (not hardcoded) keeps getItemLayout exact for the articles
  // below it (audit §7.1 — O(1) scroll). The full snapshot (results + interim) drives
  // the "n/17 champs" text + the "name known" highlight on each card.
  const { scans: pendingScans, results: scanResults, interim: scanInterim } = useScanQueue();
  const visiblePendingScans = useMemo(
    () =>
      sortPendingScansNewestFirst(
        pendingScans.filter(
          (scan) => !scan.businessPortalId || scan.businessPortalId === businessPortalId,
        ),
      ),
    [businessPortalId, pendingScans],
  );
  const [listHeaderHeight, setListHeaderHeight] = useState(0);
  // At most one in-progress scan may expose its destructive action. Starting a
  // swipe on another scan changes ownership; the previous card observes the change
  // and animates back to its resting position.
  const [openPendingSwipeId, setOpenPendingSwipeId] = useState<string | null>(null);
  const handleListHeaderLayout = useCallback((e: LayoutChangeEvent) => {
    setListHeaderHeight(e.nativeEvent.layout.height);
  }, []);
  const getItemLayout = useCallback(
    (_data: ArrayLike<Article> | null | undefined, index: number) => ({
      length: ITEM_HEIGHT,
      offset: listHeaderHeight + ITEM_HEIGHT * index,
      index,
    }),
    [listHeaderHeight],
  );

  const handleOpenScan = useCallback(
    (scan: PendingScan) => navigation.navigate('Review', { pendingScanId: scan.id }),
    [navigation],
  );
  const handleRetryScan = useCallback((id: string) => {
    void retryScan(id);
  }, []);
  const handleDiscardScan = useCallback((id: string) => {
    setOpenPendingSwipeId((current) => (current === id ? null : current));
    void discardScan(id);
  }, []);
  const handlePendingSwipeStart = useCallback((id: string) => {
    setOpenPendingSwipeId(id);
  }, []);
  const handlePendingSwipeClose = useCallback((id: string) => {
    setOpenPendingSwipeId((current) => (current === id ? null : current));
  }, []);

  // List header: "En cours" scans (day-independent — active work is always visible),
  // then the discreet label of the day currently scoping the articles below. Always
  // rendered (even empty) so onLayout keeps getItemLayout's offset exact.
  const listHeader = useMemo(() => {
    return (
      <View onLayout={handleListHeaderLayout}>
        {visiblePendingScans.length > 0 && (
          <Text style={[typography.titleLarge, styles.pendingTitle]}>
            {`En cours (${visiblePendingScans.length})`}
          </Text>
        )}
        {visiblePendingScans.map((scan) => {
          // /17 score + name-known probe: prefer the FINAL run when ready, else the
          // Tier-3 interim preview (while extracting); submitting scans show 0/17.
          // The scan's persisted review draft (edits) OVERLAYS both, so the gauge
          // advances live as the operator fills fields across review sessions.
          const result = scanResults[scan.id];
          const interimValues = scanInterim[scan.id];
          const scanProfile = businessProfileFor(scan.tradeCode ?? tradeCode);
          const filledCount = result?.run
            ? filledCountFromRun(result.run.fields, scan.edits, scanProfile.code)
            : filledCountFromInterim(interimValues, scan.edits, scanProfile.code);
          const nameKnown = result?.run
            ? isProductNameKnownFromRun(result.run.fields, scan.edits)
            : isProductNameKnownFromInterim(interimValues, scan.edits);
          return (
            <PendingScanCard
              key={scan.id}
              scan={scan}
              filledCount={filledCount}
              totalFieldCount={scanProfile.fields.length}
              nameKnown={nameKnown}
              onOpen={handleOpenScan}
              onRetry={handleRetryScan}
              onDiscard={handleDiscardScan}
              swipeOpen={openPendingSwipeId === scan.id}
              onSwipeStart={handlePendingSwipeStart}
              onSwipeClose={handlePendingSwipeClose}
            />
          );
        })}
        <View style={styles.sectionHeading}>
          <View style={styles.sectionCopy}>
            <Text style={[typography.titleLarge, styles.sectionTitle]} numberOfLines={1}>
              {searching
                ? 'Résultats'
                : selectedDay === todayKey()
                  ? 'Aujourd’hui'
                  : formatDayKey(selectedDay)}
            </Text>
            <Text style={[typography.labelMedium, styles.sectionSubtitle]}>
              {searching
                ? `${dayScoped.length} correspondance${dayScoped.length !== 1 ? 's' : ''}`
                : `${dayScoped.length} arrivage${dayScoped.length !== 1 ? 's' : ''}`}
            </Text>
          </View>
          {!searching && selectedDay !== todayKey() ? (
            <Pressable
              onPress={() => setSelectedDay(todayKey())}
              style={styles.todayButton}
              android_ripple={{ color: colors.primaryContainer }}
              accessibilityRole="button"
              accessibilityLabel="Revenir aux arrivages d’aujourd’hui"
            >
              <MaterialCommunityIcons name="calendar-today" size={16} color={colors.onPrimaryContainer} />
              <Text style={[typography.labelMedium, styles.todayButtonText]}>Aujourd’hui</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }, [
    visiblePendingScans,
    scanResults,
    scanInterim,
    searching,
    selectedDay,
    dayScoped.length,
    handleListHeaderLayout,
    handleOpenScan,
    handleRetryScan,
    handleDiscardScan,
    openPendingSwipeId,
    handlePendingSwipeStart,
    handlePendingSwipeClose,
    tradeCode,
  ]);

  // Search and calendar both slide open from the header (homogeneous actions);
  // only one panel is open at a time.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarAnim = useRef(new Animated.Value(0)).current;
  // The panel's natural height, measured from an absolutely-positioned inner view
  // (measurable even while the slide is at height 0) — the slide animates 0 → this.
  const [calendarHeight, setCalendarHeight] = useState(0);

  const closeSearch = useCallback(() => {
    searchInputRef.current?.blur();
    setQuery('');
    Animated.timing(searchAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: false,
    }).start(() => setSearchOpen(false));
  }, [searchAnim, setQuery]);

  const closeCalendar = useCallback(() => {
    Animated.timing(calendarAnim, {
      toValue: 0,
      duration: 180,
      useNativeDriver: false,
    }).start(() => setCalendarOpen(false));
  }, [calendarAnim]);

  const openSearch = useCallback(() => {
    if (calendarOpen) closeCalendar();
    setSearchOpen(true);
    Animated.timing(searchAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: false,
    }).start();
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchAnim, calendarOpen, closeCalendar]);

  const openCalendar = useCallback(() => {
    if (searchOpen) closeSearch();
    setCalendarOpen(true);
    Animated.timing(calendarAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [calendarAnim, searchOpen, closeSearch]);

  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch();
    else openSearch();
  }, [searchOpen, openSearch, closeSearch]);

  const toggleCalendar = useCallback(() => {
    if (calendarOpen) closeCalendar();
    else openCalendar();
  }, [calendarOpen, openCalendar, closeCalendar]);

  // Picking a day re-scopes the list instantly (in-memory filter — no reload) and
  // closes the panel.
  const handleSelectDay = useCallback(
    (key: string) => {
      if (key > todayKey()) return;
      setSelectedDay(key);
      closeCalendar();
    },
    [closeCalendar],
  );

  // A validated review places its card in this cache immediately. Avoid refetching
  // on the return navigation: the server's asynchronous projection may not yet be
  // visible, which used to make that new card disappear. Pull-to-refresh remains the
  // explicit, sober way to ask for the latest server data.
  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // Stable callbacks + renderItem so React.memo(ArticleCard) actually skips unchanged rows.
  const handleOpen = useCallback(
    (a: Article) => navigation.navigate('ArticleDetail', { articleId: a.id }),
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: Article }) => (
      <ArticleCard article={item} onOpen={handleOpen} />
    ),
    [handleOpen],
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

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Branded app bar */}
      <View style={styles.appBar}>
        <View style={styles.brand}>
          <Image
            source={require('../../assets/labelscan-logo.png')}
            style={styles.brandMark}
            accessibilityLabel="Logo LabelScan"
          />
          <View style={styles.brandText}>
            <Text style={[typography.titleLarge, styles.brandTitle]}>LabelScan</Text>
            <Text style={[typography.labelSmall, styles.brandSubtitle]} numberOfLines={1}>
              {businessProfile.displayName}
            </Text>
          </View>
        </View>

        <View style={styles.appBarActions}>
          <Pressable
            onPress={toggleCalendar}
            style={[styles.iconButton, calendarOpen && styles.iconButtonActive]}
            android_ripple={{ color: colors.primaryContainer, borderless: true }}
            accessibilityRole="button"
            accessibilityLabel={calendarOpen ? 'Fermer le calendrier' : 'Calendrier'}
            accessibilityState={{ expanded: calendarOpen }}
          >
            <View style={styles.iconGlyphSlot}>
              <Ionicons
                name={calendarOpen ? 'calendar' : 'calendar-outline'}
                size={22}
                color={calendarOpen ? colors.primary : colors.onSurfaceVariant}
              />
            </View>
          </Pressable>
          <Pressable
            onPress={toggleSearch}
            style={[styles.iconButton, searchOpen && styles.iconButtonActive]}
            android_ripple={{ color: colors.primaryContainer, borderless: true }}
            accessibilityRole="button"
            accessibilityLabel={searchOpen ? 'Fermer la recherche' : 'Rechercher'}
            accessibilityState={{ expanded: searchOpen }}
          >
            <View style={styles.iconGlyphSlot}>
              <Ionicons
                name={searchOpen ? 'close-outline' : 'search-outline'}
                size={22}
                color={searchOpen ? colors.primary : colors.onSurfaceVariant}
              />
            </View>
          </Pressable>
          <Pressable
            onPress={showExportOptions}
            disabled={exporting}
            style={styles.iconButton}
            android_ripple={{ color: colors.primaryContainer, borderless: true }}
            accessibilityRole="button"
            accessibilityLabel="Exporter les articles"
            accessibilityState={{ disabled: exporting }}
          >
            <View style={styles.iconGlyphSlot}>
              <Ionicons
                name="share-outline"
                size={22}
                color={exporting ? colors.outline : colors.onSurfaceVariant}
              />
            </View>
          </Pressable>
          <Pressable
            onPress={handleSignOut}
            style={styles.iconButton}
            android_ripple={{ color: colors.primaryContainer, borderless: true }}
            accessibilityRole="button"
            accessibilityLabel="Se déconnecter"
          >
            <View style={styles.iconGlyphSlot}>
              <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceVariant} />
            </View>
          </Pressable>
        </View>
      </View>

      {/* Slide-open calendar (driven by the header calendar button) — a date
          selector, never a page: picking a day swaps the list content below. */}
      <Animated.View
          pointerEvents={calendarOpen ? 'auto' : 'none'}
          style={[
            styles.calendarSlide,
            {
              height: calendarAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, calendarHeight],
              }),
              opacity: calendarAnim,
            },
          ]}
        >
          <View
            style={styles.calendarContent}
            onLayout={(e) => setCalendarHeight(e.nativeEvent.layout.height)}
          >
            <CalendarPanel
              open={calendarOpen}
              counts={dayCounts}
              selectedDay={selectedDay}
              onSelectDay={handleSelectDay}
            />
          </View>
      </Animated.View>

      {/* Slide-open search (driven by the header search button) */}
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
                placeholder="Rechercher : produit, lot, origine…"
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

      {/* List — the complete catalogue or the selected day's arrivals, sorted by name */}
      <FlatList
        data={ordered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ListHeaderComponent={listHeader}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        contentContainerStyle={[
          styles.listContent,
          // Extra bottom space so the FAB never covers the last card.
          { paddingBottom: insets.bottom + spacing['3xl'] + 72 },
        ]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
            progressViewOffset={spacing.sm}
            title="Actualisation…"
            titleColor={colors.onSurfaceVariant}
          />
        }
        ListEmptyComponent={
          searching ? (
            <View style={styles.noResults}>
              <MaterialCommunityIcons name="magnify-close" size={40} color={colors.onSurfaceVariant} />
              <Text style={[typography.bodyMedium, styles.noResultsText]}>
                Aucun résultat pour « {query.trim()} ».
              </Text>
            </View>
          ) : visiblePendingScans.length === 0 ? (
            selectedDay === todayKey() ? (
              <EmptyState onAction={openCapture} />
            ) : (
              <View style={styles.emptyArrival}>
                <Text style={[typography.bodyMedium, styles.noResultsText]}>Aucun arrivage</Text>
              </View>
            )
          ) : null
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
    paddingHorizontal: spacing.md,
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
    width: 40,
    height: 40,
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
    justifyContent: 'flex-end',
    gap: 0,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonActive: {
    backgroundColor: colors.primaryContainer,
  },
  // Vector icons are font glyphs with different baselines. Centering each one in
  // the same nested slot avoids baseline drift between calendar/search/export/logout.
  iconGlyphSlot: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── Slide-open calendar ────────────────────────────────────────────────────────
  calendarSlide: {
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  // Absolute so the panel keeps its natural height (measurable) while the slide
  // is collapsed to 0.
  calendarContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
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
    flexGrow: 1,
    paddingTop: spacing.md,
  },
  pendingTitle: {
    color: colors.onSurface,
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  todayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.primaryContainer,
    overflow: 'hidden',
  },
  todayButtonText: {
    color: colors.onPrimaryContainer,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionCopy: {
    flex: 1,
    minWidth: 0,
    paddingRight: spacing.sm,
  },
  sectionTitle: {
    color: colors.onSurface,
  },
  sectionSubtitle: {
    color: colors.onSurfaceVariant,
    marginTop: 2,
  },
  noResults: {
    alignItems: 'center',
    paddingTop: spacing['2xl'],
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  emptyArrival: {
    alignItems: 'center',
    paddingTop: spacing['2xl'],
    paddingHorizontal: spacing.lg,
  },
  noResultsText: {
    color: colors.onSurfaceVariant,
    textAlign: 'center',
  },
});
