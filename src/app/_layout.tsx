import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Drawer } from 'expo-router/drawer';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider } from '@/app-state';
import { ConsentSheet } from '@/ui/consent-sheet';
import { AppDrawer } from '@/ui/drawer';
import { getTheme } from '@/ui/theme';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout.
 *
 * `AppProvider` wraps everything because it owns the inference engine, and the
 * engine must be a singleton for the life of the process — two engines would
 * mean two loaded models and an immediate memory kill.
 *
 * Navigation is a drawer rather than a tab bar. Tabs imply several destinations
 * of equal weight; this app has one screen you live in and two you visit, and
 * putting a permanent bar across the bottom of a conversation spends 60pt of a
 * phone screen on navigation the user needs a few times an hour. The drawer
 * also gives conversation history somewhere to live that is one gesture away
 * from anywhere.
 *
 * Headers are hidden throughout because each screen supplies its own chrome.
 */
export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = getTheme(colorScheme === 'light' ? 'light' : 'dark');

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={colorScheme === 'light' ? DefaultTheme : DarkTheme}>
          <AppProvider>
            {/* The background lives here rather than per screen so navigation
                transitions never flash the system default underneath. */}
            <View style={{ flex: 1, backgroundColor: theme.color.background }}>
              <Drawer
                drawerContent={(props) => <AppDrawer {...props} />}
                screenOptions={{
                  headerShown: false,
                  // `front` slides the drawer over the conversation rather than
                  // pushing it sideways. Pushing looks impressive and costs a
                  // full-screen re-layout on every drag frame.
                  drawerType: 'front',
                  drawerStyle: {
                    backgroundColor: theme.color.backgroundElevated,
                    width: 300,
                    borderRightWidth: 0,
                  },
                  overlayColor: 'rgba(0,0,0,0.55)',
                  // Wide enough to catch a thumb reaching from the bezel,
                  // narrow enough not to swallow horizontal scrolls in code
                  // blocks and tables.
                  swipeEdgeWidth: 60,
                }}
              >
                <Drawer.Screen name="index" options={{ title: 'Chat' }} />
                <Drawer.Screen name="models" options={{ title: 'Models' }} />
                <Drawer.Screen name="settings" options={{ title: 'Settings' }} />
              </Drawer>
            </View>

            {/* Mounted above the navigator so a consent request is visible from
                whichever screen the turn was started on. */}
            <ConsentSheet />
            <StatusBar style={colorScheme === 'light' ? 'dark' : 'light'} />
          </AppProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
