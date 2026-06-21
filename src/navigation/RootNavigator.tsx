/**
 * RootNavigator — single root stack.
 *
 * Articles is the HOME screen. Capture is no longer a bottom tab; it is launched
 * on demand from a FAB on the article list and lives as pushed screens on the same
 * stack (Camera → Review). The Camera screen is therefore mounted only while the
 * capture module is open and unmounted as soon as it is popped — which frees the
 * camera resource when the operator is not capturing (expo-camera allows only one
 * active preview at a time).
 *
 * Capture loop (rapid continuous capture):
 *   ArticleList --FAB--> Camera --take--> Review --Valider--> back to the open Camera
 *   (ready for the next label). The Camera has a back control to return to Articles,
 *   which pops the whole capture module (unmounting the camera).
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

/** Legacy on-device OCR review params (backend_first=false). */
export type LegacyReviewParams = {
  mode?: 'legacy';
  photoUri: string;
  ocrText: string;
  barcodeValue?: string;
  capturedAt: string;
};

/**
 * Backend-extraction review params (backend_first=true).
 *
 * Cascade: Camera navigates here the instant the upload is accepted — it does NOT
 * wait for extraction. Review decodes `barcodeRaw` (GS1) for the T+0 fields and polls
 * the rest itself (useIngestionResult), so only the id + the already-known capture
 * context travel through navigation.
 */
export type BackendReviewParams = {
  mode: 'backend';
  ingestionId: string;
  photoUri?: string;
  barcodeRaw?: string;
  /** Client capture time — shown in the header at T+0, before the server responds. */
  capturedAt?: string;
  /** ms epoch when submit started — lets Review measure the perceived wait (dev only). */
  submittedAt?: number;
};

type ReviewParams = LegacyReviewParams | BackendReviewParams;

/**
 * One flat root stack. Camera + Review are the capture module (pushed on demand);
 * keeping them on the same stack as the article screens lets Review pop straight
 * back to the still-mounted Camera to continue the capture loop.
 */
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
