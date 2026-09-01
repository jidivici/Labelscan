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
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './src/services/queryClient';
import { useAuth } from './src/context/AuthContext';
import { purgeLegacyLocalData } from './src/services/sessionData';

function AuthenticatedLifecycle({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();

  useEffect(() => {
    if (status !== 'signedIn') return undefined;
    let disposed = false;
    let unregisterQueue: (() => void) | undefined;
    let unregisterDrain: (() => void) | undefined;
    void initScanQueue().then(() => {
      if (disposed) return;
      unregisterQueue = registerScanQueueLifecycle();
      unregisterDrain = registerOutboxDrainOnForeground();
    });
    return () => {
      disposed = true;
      unregisterQueue?.();
      unregisterDrain?.();
    };
  }, [status]);

  return <>{children}</>;
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    void purgeLegacyLocalData();
  }, []);

  // Don't render until fonts are ready (prevents flash of unstyled text).
  // If font loading fails, render anyway — Inter will fall back to system font.
  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthenticatedLifecycle>
              <RootNavigator />
            </AuthenticatedLifecycle>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
