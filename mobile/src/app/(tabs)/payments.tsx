import { RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { colors } from '../../constants/colors';
import { EmptyState, ErrorBanner, Loading, Pill } from '../../components/ui';
import { formatMoney } from '../../lib/due';
import { CHANNEL_LABELS, CONTRACT_TYPE_LABELS, formatDateTime } from '../../lib/format';
import type { Payment } from '../../lib/types';

/** Money taken back out to the customer: a savings withdrawal, or a refund of overpaid credit. */
const MONEY_OUT = ['WITHDRAWAL', 'CREDIT_REFUND'];

/**
 * Every payment on the customer's contracts, newest first, by month. The
 * server lists completed payments only; a reversed one is marked and left
 * out of the month's total, and the reversal entry itself is not listed.
 */
export default function Payments() {
  const insets = useSafeAreaInsets();
  const { data, error, refreshing, reload } = useLoad(api.payments);

  const sections = groupByMonth((data ?? []).filter((p) => !p.reversesPaymentId));
  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <Text style={styles.heading}>Payments</Text>
      {!data && !error ? <Loading /> : (
        <SectionList
          sections={sections}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={error ? <ErrorBanner message={error} onRetry={reload} /> : undefined}
          ListEmptyComponent={error ? undefined : <EmptyState icon="receipt-outline" title="No payments yet" />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} colors={[colors.primary]} />}
          renderSectionHeader={({ section }) => (
            <View style={styles.month}>
              <Text style={styles.monthTitle}>{section.title}</Text>
              <Text style={styles.monthTotal}>{formatMoney(section.totalMinor)}</Text>
            </View>
          )}
          renderItem={({ item }) => <PaymentRow payment={item} />}
        />
      )}
    </View>
  );
}

function PaymentRow({ payment: p }: { payment: Payment }) {
  const out = MONEY_OUT.includes(p.entryType);
  const reversed = !!p.reversedById;
  const what = p.contract ? `${CONTRACT_TYPE_LABELS[p.contract.contractType] ?? 'Contract'} ${p.contract.contractNumber}` : 'Payment';
  return (
    <View style={styles.row}>
      <View style={[styles.icon, { backgroundColor: reversed ? colors.dangerSoft : out ? colors.warningSoft : colors.successSoft }]}>
        <Ionicons name={reversed ? 'close' : out ? 'arrow-up' : 'arrow-down'} size={18} color={reversed ? colors.danger : out ? colors.warning : colors.success} />
      </View>
      <View style={{ flex: 1, marginHorizontal: 12 }}>
        <Text style={styles.what} numberOfLines={1}>{out ? (p.entryType === 'WITHDRAWAL' ? 'Withdrawal' : 'Refund') : what}</Text>
        <Text style={styles.meta}>{CHANNEL_LABELS[p.channel] ?? p.channel} · {formatDateTime(p.receivedAt ?? p.createdAt)}</Text>
        {p.receiptNumber ? <Text style={styles.meta}>Receipt {p.receiptNumber}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.amount, reversed && styles.struck]}>{out ? '-' : ''}{formatMoney(p.amountMinor)}</Text>
        {reversed && <Pill label="Reversed" color={colors.danger} background={colors.dangerSoft} />}
      </View>
    </View>
  );
}

function groupByMonth(payments: Payment[]) {
  const sorted = [...payments].sort((a, b) => (b.receivedAt ?? b.createdAt).localeCompare(a.receivedAt ?? a.createdAt));
  const sections: { title: string; totalMinor: number; data: Payment[] }[] = [];
  for (const p of sorted) {
    const title = new Date(p.receivedAt ?? p.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    let section = sections[sections.length - 1];
    if (!section || section.title !== title) sections.push(section = { title, totalMinor: 0, data: [] });
    section.data.push(p);
    if (!p.reversedById) section.totalMinor += MONEY_OUT.includes(p.entryType) ? -p.amountMinor : p.amountMinor;
  }
  return sections;
}

const styles = StyleSheet.create({
  heading: { fontSize: 24, fontWeight: '800', color: colors.text, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  month: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, marginBottom: 8 },
  monthTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  monthTotal: { fontSize: 14, fontWeight: '700', color: colors.success },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8 },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  what: { fontSize: 14, fontWeight: '600', color: colors.text },
  meta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: '700', color: colors.text },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },
});
