import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SessionProvider, useSession } from '../lib/session';
import { colors } from '../constants/colors';

// Kept up until the stored session has been read and the icon font loaded.
SplashScreen.preventAutoHideAsync();

// Opened straight from a link (flezepay://pay?contract=…), Pay still has the tabs to go back to.
export const unstable_settings = { anchor: '(tabs)' };

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <RootNavigator />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

/**
 * Signed out: sign in, or reset a password. Signed in on a temporary
 * password from staff: choose your own first. Otherwise the tabs, and Pay
 * above them so it opens the same way from every tab (and from a
 * flezepay://pay?contract=… link).
 */
function RootNavigator() {
  const { customer, isLoading } = useSession();
  const [fontsLoaded] = useFonts(Ionicons.font);
  if (isLoading || !fontsLoaded) return null;
  SplashScreen.hide();

  const signedIn = !!customer;
  const mustChoosePassword = !!customer?.mustChangePassword;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={signedIn && !mustChoosePassword}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="pay"
          options={{ headerShown: true, title: 'Make Payment', headerTintColor: colors.primary, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background } }}
        />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && mustChoosePassword}>
        <Stack.Screen name="choose-password" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="reset-password" />
      </Stack.Protected>
    </Stack>
  );
}
