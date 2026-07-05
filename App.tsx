/**
 * App.tsx — Entry point
 * Loads Inter fonts, sets up GestureHandlerRootView, renders navigator
 */

import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native';

import { registerOutboxDrainOnForeground } from './src/services/outboxDrain';
import { initScanQueue, registerScanQueueLifecycle } from './src/services/scanQueue';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';

import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AuthProvider } from './src/context/AuthContext';

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // P3: replay pending review writes (field overrides / confirms) whenever the app
  // starts or returns to the foreground — the moment connectivity most plausibly
  // came back. Server-side Idempotency-Key dedup makes replays safe.
  useEffect(() => registerOutboxDrainOnForeground(), []);

  // Workflow v1: restore queued scans (they survive a restart) and let the queue
  // pause/resume its polls with the app state.
  useEffect(() => {
    const unsubscribe = registerScanQueueLifecycle();
    void initScanQueue();
    return unsubscribe;
  }, []);

  // Don't render until fonts are ready (prevents flash of unstyled text).
  // If font loading fails, render anyway — Inter will fall back to system font.
  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
