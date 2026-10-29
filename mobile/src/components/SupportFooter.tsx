import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../constants/colors';
import { APP_CONFIG } from '../constants/config';
import { useSession } from '../lib/session';

/**
 * Tap-to-call support numbers and the developer credit, on the sign-in,
 * reset and profile screens. The numbers are the company's (Settings in the
 * web app) and, once signed in, the customer's own branch.
 */
export function supportNumbers(org: { phone: string | null }, branchPhone?: string | null): string[] {
  return [...new Set([branchPhone, org.phone].map((p) => p?.trim()).filter((p): p is string => !!p))];
}

export function callNumber(phone: string) {
  void Linking.openURL(`tel:${phone.replace(/\s/g, '')}`);
}

export function SupportFooter() {
  const { org, customer } = useSession();
  const numbers = supportNumbers(org, customer?.branch?.phone);
  return (
    <View style={styles.wrap}>
      {numbers.length > 0 && <Text style={styles.heading}>Need help? Call us</Text>}
      {numbers.map((n) => (
        <Pressable key={n} onPress={() => callNumber(n)} style={styles.phone} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Call customer service on ${n}`}>
          <Ionicons name="call" size={16} color={colors.primary} />
          <Text style={styles.phoneText}>{n}</Text>
        </Pressable>
      ))}
      <Pressable onPress={() => void Linking.openURL(APP_CONFIG.developer.url)} accessibilityRole="link" hitSlop={6} style={{ marginTop: 16 }}>
        <Text style={styles.credit}>System developed by <Text style={styles.creditLink}>{APP_CONFIG.developer.name}</Text></Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 24 },
  heading: { fontSize: 13, color: colors.textMuted, marginBottom: 6 },
  phone: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, minHeight: 36 },
  phoneText: { fontSize: 15, fontWeight: '600', color: colors.primary },
  credit: { fontSize: 12, color: colors.textMuted },
  creditLink: { color: colors.primary, fontWeight: '600' },
});
