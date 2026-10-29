import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { colors } from '../constants/colors';
import { Card, Pill, ProgressBar } from './ui';
import { formatDate, contractTitle, statusStyle } from '../lib/format';
import { formatMoney, isLoan, isPayable, isSavings, progress } from '../lib/due';
import type { Contract } from '../lib/types';

export function openContract(id: string) {
  router.push({ pathname: '/contracts/[id]', params: { id } }, { withAnchor: true });
}

export function openPay(contractId?: string) {
  router.push(contractId ? { pathname: '/pay', params: { contract: contractId } } : '/pay');
}

/** One contract at a glance: what it is, how far paid, what is late, and Pay when anything can be paid. */
export function ContractCard({ contract: c }: { contract: Contract }) {
  const status = statusStyle(c.status);
  const share = progress(c);
  const payable = isPayable(c);
  const owed = c.due.totalDueMinor ?? 0;
  const summary = isSavings(c)
    ? `Saved ${formatMoney(c.totalPaidMinor)}`
    : isLoan(c)
      ? `Owed ${formatMoney(owed)}`
      : `${Math.round((share ?? 0) * 100)}% paid · ${formatMoney(owed)} left`;

  return (
    <Card onPress={() => openContract(c.id)} style={styles.card} accessibilityLabel={`${contractTitle(c)}, ${c.contractNumber}`}>
      <View style={styles.top}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={styles.title} numberOfLines={1}>{contractTitle(c)}</Text>
          <Text style={styles.number}>{c.contractNumber}</Text>
        </View>
        <Pill label={status.label} color={status.color} background={status.background} />
      </View>
      {share !== null && <View style={{ marginTop: 12 }}><ProgressBar value={share} /></View>}
      <Text style={styles.summary}>{summary}</Text>
      {c.due.overdueMinor + c.due.penaltyOutstandingMinor > 0 ? (
        <Text style={styles.overdue}>{formatMoney(c.due.overdueMinor + c.due.penaltyOutstandingMinor)} overdue</Text>
      ) : c.due.nextDueDate ? (
        <Text style={styles.next}>Next {formatMoney(c.due.nextDueMinor)} on {formatDate(c.due.nextDueDate)}</Text>
      ) : null}
      {payable && (
        <Pressable onPress={() => openPay(c.id)} style={styles.payChip} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Pay ${c.contractNumber}`}>
          <Text style={styles.payChipText}>Pay</Text>
        </Pressable>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  title: { fontSize: 16, fontWeight: '700', color: colors.text },
  number: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  summary: { fontSize: 13, color: colors.text, marginTop: 8 },
  overdue: { fontSize: 13, color: colors.danger, fontWeight: '700', marginTop: 4 },
  next: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  payChip: { position: 'absolute', right: 14, bottom: 14, backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  payChipText: { color: colors.white, fontWeight: '700' },
});
