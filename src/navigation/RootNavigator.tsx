/**
 * RootNavigator — single root stack.
 *
 * Articles is the HOME screen. Capture (Camera) is launched on demand from the
 * FAB and stays open for chained shots — the shutter enqueues each photo in the
 * scan queue (src/services/scanQueue.ts) and the operator keeps shooting; there
 * is no per-photo review pushed from the camera anymore (workflow v1).
 *
 * Review is now opened ONLY from the home screen's "En cours" section, once a
 * queued scan reaches its 'ready' step — by `pendingScanId`, never by carrying
 * the ingestion/photo data through navigation params (the scan queue is the
 * single source of truth for that data, screen-independent).
 */

import React, { Suspense } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import { CameraScreen } from '../screens/CameraScreen';
import { ReviewScreen } from '../screens/ReviewScreen';
import { ArticleListScreen } from '../screens/ArticleListScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme';

// ── Param lists ────────────────────────────────────────────────────────────────

/**
 * Review params (workflow v1): a queued scan's LOCAL id. Everything else (photo,
 * barcode, ingestion id, extraction result) is read live from the scan queue
 * (useScan) — never carried through navigation, so Review always shows the
 * queue's current truth even if it changed while this screen wasn't mounted.
 */
export type ReviewParams = { pendingScanId: string };

/** One flat root stack. Camera is the capture module; Review opens from Articles. */
export type RootStackParamList = {
  ArticleList: undefined;
  /** Full immutable record (the "lot") for one saved article, by local id. */
  ArticleDetail: { articleId: string };
  Camera: undefined;
  Review: ReviewParams;
};

// Back-compat aliases for screens still importing the old stack param names.
export type CaptureStackParamList = RootStackParamList;
export type ArticlesStackParamList = RootStackParamList;

// ── Navigator ────────────────────────────────────────────────────────────────

const RootStack = createStackNavigator<RootStackParamList>();

// Lazy "Fiche Produit": its module is loaded only the first time a record is opened
// (its data is already fetched on demand via getArticleById). NOTE: under Metro this
// defers module evaluation rather than code-splitting the bundle, but it honours the
// lazy-load pattern and keeps the detail screen off the cold-start path.
const ArticleDetailScreen = React.lazy(() =>
  import('../screens/ArticleDetailScreen').then((m) => ({ default: m.ArticleDetailScreen })),
);

function ArticleDetailLazy() {
  return (
    <Suspense
      fallback={
        <View style={styles.splash}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      }
    >
      <ArticleDetailScreen />
    </Suspense>
  );
}

function AppNavigator() {
  return (
    <RootStack.Navigator
      initialRouteName="ArticleList"
      screenOptions={{ headerShown: false }}
    >
      <RootStack.Screen name="ArticleList" component={ArticleListScreen} />
      <RootStack.Screen name="ArticleDetail" component={ArticleDetailLazy} />
      <RootStack.Screen name="Camera" component={CameraScreen} />
      <RootStack.Screen
        name="Review"
        component={ReviewScreen}
        options={{ presentation: 'modal' }}
      />
    </RootStack.Navigator>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────────

export function RootNavigator() {
  const { status } = useAuth();

  // Restoring the persisted session on cold start.
  if (status === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Auth gate: the whole app sits behind a successful sign-in.
  if (status === 'signedOut') {
    return <LoginScreen />;
  }

  return (
    <NavigationContainer>
      <AppNavigator />
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
