import { Stack } from 'expo-router';
import { colors } from '../../../constants/colors';

// A contract opened from Home (or a link) still goes back to the list.
export const unstable_settings = { anchor: 'index' };

export default function ContractsLayout() {
  return (
    <Stack screenOptions={{ headerTintColor: colors.primary, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background }, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="index" options={{ title: 'My Contracts' }} />
      <Stack.Screen name="[id]" options={{ title: 'Contract' }} />
    </Stack>
  );
}
