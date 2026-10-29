import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { Tabs, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../../constants/colors';

type IconName = keyof typeof Ionicons.glyphMap;

/** Filled when the tab is open, outlined when not. */
function TabIcon({ focused, color, active, inactive }: { focused: boolean; color: ColorValue; active: IconName; inactive: IconName }) {
  return <Ionicons name={focused ? active : inactive} size={24} color={typeof color === 'string' ? color : undefined} />;
}

/**
 * Home, Contracts, the raised Pay button, Payments and Profile. Pay is one
 * tap from every screen: the centre button opens the Pay screen (above the
 * tabs, see app/_layout.tsx) instead of switching tab.
 */
export default function TabLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          height: 64 + insets.bottom, paddingBottom: insets.bottom + 6, paddingTop: 6,
          borderTopWidth: 0, elevation: 12, shadowColor: '#0F172A', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: -2 },
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: (p) => <TabIcon {...p} active="home" inactive="home-outline" /> }} />
      <Tabs.Screen name="contracts" options={{ title: 'Contracts', tabBarIcon: (p) => <TabIcon {...p} active="document-text" inactive="document-text-outline" /> }} />
      <Tabs.Screen name="pay-button" options={{ title: 'Pay', tabBarButton: () => <PayButton /> }} />
      <Tabs.Screen name="payments" options={{ title: 'Payments', tabBarIcon: (p) => <TabIcon {...p} active="receipt" inactive="receipt-outline" /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: (p) => <TabIcon {...p} active="person" inactive="person-outline" /> }} />
    </Tabs>
  );
}

function PayButton() {
  return (
    <View style={styles.payWrap}>
      <Pressable onPress={() => router.push('/pay')} style={({ pressed }) => [styles.payCircle, pressed && { opacity: 0.85 }]}
        accessibilityRole="button" accessibilityLabel="Make a payment" hitSlop={6}>
        <Ionicons name="wallet" size={26} color={colors.white} />
      </Pressable>
      <Text style={styles.payLabel}>Pay</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  payWrap: { flex: 1, alignItems: 'center' },
  payCircle: {
    width: 58, height: 58, borderRadius: 29, marginTop: -22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 4, borderColor: colors.white, shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  payLabel: { fontSize: 11, fontWeight: '700', color: colors.primary, marginTop: 2 },
});
