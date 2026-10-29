import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import { colors } from '../../constants/colors';
import { Button, Card, EmptyState, ErrorBanner, Loading, SectionTitle } from '../../components/ui';
import { ContractCard, openPay } from '../../components/ContractCard';
import { callNumber, supportNumbers } from '../../components/SupportFooter';
import { dueNowMinor, formatMoney, isPayable } from '../../lib/due';
import { formatDate } from '../../lib/format';

const LIVE = ['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'];

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/** What is owed now, the totals, the latest contracts, and help: everything a customer opens the app for. */
export default function Home() {
  const insets = useSafeAreaInsets();
  const { customer, org } = useSession();
  const { data: contracts, error, refreshing, reload } = useLoad(api.contracts);

  const payable = (contracts ?? []).filter(isPayable);
  const dueNow = payable.reduce((s, c) => s + dueNowMinor(c), 0);
  const overdueCount = payable.reduce((s, c) => s + c.due.overdueCount, 0);
  const next = payable
    .filter((c) => c.due.nextDueDate)
    .sort((a, b) => a.due.nextDueDate!.localeCompare(b.due.nextDueDate!))[0];
  const balance = (contracts ?? []).filter((c) => LIVE.includes(c.status)).reduce((s, c) => s + (c.due.totalDueMinor ?? 0), 0);
  const paid = (contracts ?? []).reduce((s, c) => s + c.totalPaidMinor, 0);
  const live = (contracts ?? []).filter((c) => LIVE.includes(c.status)).length;
  const help = supportNumbers(org, customer?.branch?.phone)[0];
  const initials = `${customer?.firstName.charAt(0) ?? ''}${customer?.lastName.charAt(0) ?? ''}`;

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 12 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} colors={[colors.primary]} />}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{greeting()},</Text>
          <Text style={styles.name} numberOfLines={1}>{customer?.firstName}</Text>
        </View>
        <Pressable onPress={() => router.navigate('/profile')} style={styles.avatar} accessibilityRole="button" accessibilityLabel="Open profile" hitSlop={6}>
          <Text style={styles.avatarText}>{initials}</Text>
        </Pressable>
      </View>

      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {!contracts ? (error ? null : <Loading />) : (
        <>
          <Card style={[styles.hero, dueNow > 0 && { backgroundColor: colors.danger }]}>
            <Text style={styles.heroLabel}>{dueNow > 0 ? 'Due now' : next ? 'Next payment' : "You're all paid up"}</Text>
            <Text style={styles.heroAmount}>{formatMoney(dueNow > 0 ? dueNow : next?.due.nextDueMinor ?? 0)}</Text>
            <Text style={styles.heroSub}>
              {dueNow > 0
                ? overdueCount > 0 ? `${overdueCount} overdue instalment${overdueCount === 1 ? '' : 's'} · pay to keep your phone unlocked` : 'Late charges are owed'
                : next ? `Due ${formatDate(next.due.nextDueDate)}` : 'No payments are due. Thank you!'}
            </Text>
            {payable.length > 0 && (
              <Button title="Pay now" variant="outline" onPress={() => openPay(payable.length === 1 ? payable[0].id : undefined)}
                style={{ marginTop: 14, borderColor: colors.white }} />
            )}
          </Card>

          <View style={styles.totals}>
            <Total label="Balance" value={formatMoney(balance)} />
            <Total label="Paid so far" value={formatMoney(paid)} />
            <Total label="Contracts" value={String(live)} />
          </View>

          <SectionTitle action={contracts.length > 3 ? (
            <Link href="/contracts" style={styles.seeAll}>See all</Link>
          ) : undefined}>My contracts</SectionTitle>
          {contracts.length === 0
            ? <EmptyState icon="document-text-outline" title="No contracts yet" hint="Your contracts appear here once you buy or save with us." />
            : contracts.slice(0, 3).map((c) => <ContractCard key={c.id} contract={c} />)}

          {help ? (
            <Card onPress={() => callNumber(help)} style={styles.help} accessibilityLabel={`Call customer service on ${help}`}>
              <Ionicons name="call" size={22} color={colors.primary} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.helpTitle}>Need help?</Text>
                <Text style={styles.helpText}>Call {org.companyName} on {help}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Card>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <Card style={styles.total}>
      <Text style={styles.totalLabel}>{label}</Text>
      <Text style={styles.totalValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  greeting: { fontSize: 14, color: colors.textMuted },
  name: { fontSize: 24, fontWeight: '800', color: colors.text },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primary, fontWeight: '800', fontSize: 16 },
  hero: { backgroundColor: colors.primary, padding: 20 },
  heroLabel: { color: colors.white, opacity: 0.85, fontSize: 14, fontWeight: '600' },
  heroAmount: { color: colors.white, fontSize: 34, fontWeight: '800', marginTop: 4 },
  heroSub: { color: colors.white, opacity: 0.9, fontSize: 13, marginTop: 4 },
  totals: { flexDirection: 'row', gap: 10, marginTop: 12 },
  total: { flex: 1, padding: 12 },
  totalLabel: { fontSize: 12, color: colors.textMuted },
  totalValue: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 2 },
  seeAll: { color: colors.primary, fontWeight: '700', fontSize: 14, padding: 4 },
  help: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  helpTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  helpText: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
