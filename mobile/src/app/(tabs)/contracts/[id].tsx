import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useLoad } from '../../../lib/useLoad';
import { colors } from '../../../constants/colors';
import { Button, Card, Chip, ErrorBanner, Loading, Pill, ProgressBar, SectionTitle } from '../../../components/ui';
import { openPay } from '../../../components/ContractCard';
import { depositLeftMinor, dueNowMinor, formatMoney, isLoan, isPayable, isSavings, progress } from '../../../lib/due';
import { contractTitle, formatDate, FREQUENCY_LABELS, statusStyle } from '../../../lib/format';
import type { Instalment } from '../../../lib/types';

/** Rows shown at first, and added per "Show more": a daily contract has hundreds. */
const SCHEDULE_PAGE = 6;
type Filter = 'TO_PAY' | 'PAID' | 'ALL';

const left = (i: Instalment) => Math.max(0, i.amountDueMinor - i.amountPaidMinor);

export default function ContractDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { data: c, error, refreshing, reload } = useLoad(() => api.contract(id));
  const [filter, setFilter] = useState<Filter>('TO_PAY');
  const [shown, setShown] = useState(SCHEDULE_PAGE);

  const rows = useMemo(() => {
    const all = c?.instalments ?? [];
    if (filter === 'TO_PAY') return all.filter((i) => left(i) > 0);
    if (filter === 'PAID') return all.filter((i) => left(i) === 0).reverse();
    return all;
  }, [c, filter]);

  if (!c) return error ? <View style={{ padding: 16 }}><ErrorBanner message={error} onRetry={reload} /></View> : <Loading />;

  const status = statusStyle(c.status);
  const share = progress(c);
  const paidCount = c.instalments.filter((i) => left(i) === 0).length;
  const now = dueNowMinor(c);
  const payable = isPayable(c);
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const lastDue = c.instalments[c.instalments.length - 1]?.dueDate ?? null;
  const barHeight = 76 + insets.bottom;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: c.contractNumber }} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: payable ? barHeight + 16 : 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} colors={[colors.primary]} />}>
        {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
        <Card>
          <View style={styles.top}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.title} numberOfLines={2}>{contractTitle(c)}</Text>
              <Text style={styles.muted}>{c.contractNumber}</Text>
            </View>
            <Pill label={status.label} color={status.color} background={status.background} />
          </View>
          <Text style={[styles.muted, { marginTop: 14 }]}>{isSavings(c) ? 'Saved' : 'Balance'}</Text>
          <Text style={styles.balance}>{formatMoney(isSavings(c) ? c.totalPaidMinor : c.due.totalDueMinor ?? 0)}</Text>
          {share !== null && (
            <>
              <View style={{ marginTop: 10 }}><ProgressBar value={share} /></View>
              <Text style={[styles.muted, { marginTop: 6 }]}>{paidCount} of {c.instalments.length} instalments paid · {Math.round(share * 100)}%</Text>
            </>
          )}
        </Card>

        {!isSavings(c) && !isLoan(c) && (
          <View style={styles.tiles}>
            <Card style={styles.tile}>
              <Text style={styles.muted}>Overdue</Text>
              <Text style={[styles.tileAmount, now > 0 && { color: colors.danger }]}>{formatMoney(now)}</Text>
              <Text style={styles.small}>
                {c.due.overdueCount > 0 ? `${c.due.overdueCount} instalment${c.due.overdueCount === 1 ? '' : 's'}` : 'Nothing late'}
                {c.due.penaltyOutstandingMinor > 0 ? ` · ${formatMoney(c.due.penaltyOutstandingMinor)} charges` : ''}
              </Text>
            </Card>
            <Card style={styles.tile}>
              <Text style={styles.muted}>Next payment</Text>
              <Text style={styles.tileAmount}>{c.due.nextDueDate ? formatMoney(c.due.nextDueMinor) : '—'}</Text>
              <Text style={styles.small}>{c.due.nextDueDate ? formatDate(c.due.nextDueDate) : 'None left'}</Text>
            </Card>
          </View>
        )}
        {depositLeftMinor(c) > 0 && (
          <Card style={{ marginTop: 12, backgroundColor: colors.warningSoft }}>
            <Text style={{ color: colors.warning, fontWeight: '700' }}>Deposit still owed: {formatMoney(depositLeftMinor(c))}</Text>
            <Text style={[styles.small, { color: colors.warning }]}>Your phone is handed over once the deposit is paid.</Text>
          </Card>
        )}
        {isLoan(c) && c.deviceLoanState && (
          <View style={styles.tiles}>
            <Card style={styles.tile}>
              <Text style={styles.muted}>Interest owed</Text>
              <Text style={styles.tileAmount}>{formatMoney(c.deviceLoanState.accruedInterestMinor)}</Text>
            </Card>
            <Card style={styles.tile}>
              <Text style={styles.muted}>Loan amount</Text>
              <Text style={styles.tileAmount}>{formatMoney(c.deviceLoanState.principalOutstanding ? c.deviceLoanState.principalMinor : 0)}</Text>
              <Text style={styles.small}>{c.deviceLoanState.principalOutstanding ? 'Still owed' : 'Repaid'}</Text>
            </Card>
          </View>
        )}

        <SectionTitle>Terms</SectionTitle>
        <Card>
          {!isSavings(c) && !isLoan(c) && (
            <>
              <Term label="Total price" value={formatMoney(c.totalPayableMinor ?? 0)} />
              <Term label="Deposit" value={formatMoney(c.depositAmountMinor)} />
              {c.instalmentAmountMinor ? <Term label="Instalment" value={`${formatMoney(c.instalmentAmountMinor)} ${(FREQUENCY_LABELS[c.paymentFrequency] ?? '').toLowerCase()}`} /> : null}
              <Term label="Ends" value={formatDate(lastDue)} />
              <Term label="Grace period" value={`${c.gracePeriodDays} day${c.gracePeriodDays === 1 ? '' : 's'}`} />
              <Term label="Late charge" value={c.penaltyRateBps > 0 ? `${(c.penaltyRateBps / 100).toFixed(2).replace(/\.00$/, '')}% of a late instalment` : 'None'} />
            </>
          )}
          <Term label="Started" value={formatDate(c.startDate)} />
          <Term label="Paid so far" value={formatMoney(c.totalPaidMinor)} />
          {c.inventoryItem ? <Term label="Serial / IMEI" value={c.inventoryItem.serialNumber} /> : null}
        </Card>

        {c.instalments.length > 0 && (
          <>
            <SectionTitle>Instalments</SectionTitle>
            <View style={styles.filters}>
              {([['TO_PAY', 'To pay'], ['PAID', 'Paid'], ['ALL', 'All']] as const).map(([key, label]) => (
                <Chip key={key} label={label} selected={filter === key} onPress={() => { setFilter(key); setShown(SCHEDULE_PAGE); }} />
              ))}
            </View>
            <Card style={{ paddingVertical: 4 }}>
              {rows.length === 0 && <Text style={[styles.muted, { paddingVertical: 12 }]}>{filter === 'PAID' ? 'Nothing paid yet' : 'Nothing left to pay'}</Text>}
              {rows.slice(0, shown).map((i) => {
                const owed = left(i);
                const late = owed > 0 && (i.status === 'OVERDUE' || new Date(i.dueDate) < startOfToday);
                const sub = owed === 0 ? `Paid${i.paidAt ? ` on ${formatDate(i.paidAt)}` : ''}`
                  : i.amountPaidMinor > 0 ? `Part paid ${formatMoney(i.amountPaidMinor)} of ${formatMoney(i.amountDueMinor)}`
                    : late ? 'Overdue' : 'Due';
                return (
                  <View key={i.id} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>#{i.instalmentNo} · {formatDate(i.dueDate)}</Text>
                      <Text style={[styles.small, late && { color: colors.danger }]}>{sub}</Text>
                    </View>
                    <Text style={[styles.rowAmount, late && { color: colors.danger }, owed === 0 && { color: colors.success }]}>
                      {formatMoney(owed === 0 ? i.amountDueMinor : owed)}
                    </Text>
                  </View>
                );
              })}
            </Card>
            {rows.length > shown && (
              <Button title={`Show more (${rows.length - shown} left)`} variant="outline" onPress={() => setShown(shown + SCHEDULE_PAGE * 2)} style={{ marginTop: 12 }} />
            )}
          </>
        )}
      </ScrollView>

      {payable && (
        <View style={[styles.payBar, { paddingBottom: insets.bottom + 12, height: barHeight }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.small}>{now > 0 ? 'Due now' : isSavings(c) ? 'Add to your savings' : 'Next payment'}</Text>
            {!isSavings(c) && <Text style={[styles.barAmount, now > 0 && { color: colors.danger }]}>{formatMoney(now > 0 ? now : c.due.nextDueMinor || (c.due.totalDueMinor ?? 0))}</Text>}
          </View>
          <Button title="Pay now" variant={now > 0 ? 'danger' : 'primary'} onPress={() => openPay(c.id)} />
        </View>
      )}
    </View>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.term}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.termValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  muted: { fontSize: 13, color: colors.textMuted },
  small: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  balance: { fontSize: 30, fontWeight: '800', color: colors.text },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 12 },
  tile: { flex: 1, padding: 14 },
  tileAmount: { fontSize: 18, fontWeight: '800', color: colors.text, marginTop: 4 },
  term: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, gap: 12 },
  termValue: { fontSize: 14, fontWeight: '600', color: colors.text, flexShrink: 1, textAlign: 'right' },
  filters: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  rowAmount: { fontSize: 14, fontWeight: '700', color: colors.text },
  payBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.white, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 12, gap: 12, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    shadowColor: '#0F172A', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: -3 }, elevation: 12,
  },
  barAmount: { fontSize: 20, fontWeight: '800', color: colors.text },
});
