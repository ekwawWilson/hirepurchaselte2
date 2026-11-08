import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../constants/colors';
import { formatMoney, unlockBanner } from '../lib/due';
import { formatDateTime } from '../lib/format';
import type { Contract } from '../lib/types';
import { Card } from './ui';

export const openUnlock = (contractId: string) => router.push({ pathname: '/open-phone', params: { contract: contractId } });

/**
 * A locked Device Financing phone, first thing on Home and on its contract
 * page: what it takes to open it, one tap away. Shows nothing otherwise.
 */
export function OpenPhoneBanner({ contract }: { contract: Contract }) {
  const banner = unlockBanner(contract);
  if (!banner) return null;
  const offer = contract.temporaryUnlock!;

  if (banner === 'CLOSED') {
    return (
      <Card style={[styles.card, { backgroundColor: colors.dangerSoft }]}>
        <Ionicons name="lock-closed" size={24} color={colors.danger} />
        <View style={styles.body}>
          <Text style={[styles.title, { color: colors.danger }]}>Your phone is locked</Text>
          <Text style={styles.text}>{offer.message}</Text>
        </View>
      </Card>
    );
  }

  const cheapest = offer.options[0];
  const open = banner === 'OPEN';
  return (
    <Card onPress={() => openUnlock(contract.id)} accessibilityLabel={open ? 'Keep my phone open' : 'Open my phone'}
      style={[styles.card, { backgroundColor: open ? colors.warningSoft : colors.danger }]}>
      <Ionicons name={open ? 'lock-open' : 'lock-closed'} size={24} color={open ? colors.warning : colors.white} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: open ? colors.warning : colors.white }]}>{open ? 'Your phone is open for now' : 'Open my phone'}</Text>
        <Text style={[styles.text, !open && { color: colors.white }]}>
          {open
            ? `Until ${formatDateTime(offer.activeUntil)}. Pay the ${formatMoney(offer.overdueMinor)} overdue before then, or it locks again.`
            : `Pay from ${formatMoney(cheapest.amountMinor)} to open it for ${cheapest.period}.`}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={open ? colors.warning : colors.white} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  body: { flex: 1 },
  title: { fontSize: 16, fontWeight: '800' },
  text: { fontSize: 13, color: colors.text, marginTop: 2 },
});
