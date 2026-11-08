import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { api } from '../lib/api';
import { colors } from '../constants/colors';
import { PAYMENT_CONFIG } from '../constants/config';
import { Button, Card, Chip, EmptyState, ErrorBanner, Loading } from '../components/ui';
import { formatMoney, networkForPhone, ownNumbers } from '../lib/due';
import { formatDateTime } from '../lib/format';
import type { Contract, Customer, UnlockOption } from '../lib/types';

type Stage = 'form' | 'waiting' | 'success' | 'failed' | 'timeout';

/**
 * Opening a locked Device Financing phone by paying part of what is overdue.
 * Opened from Home, a contract page or the lock screen's button
 * (flezepay://open-phone?contract=…). The customer chooses a tier; the server
 * works out the amount, and the phone opens once the payment is confirmed.
 */
export default function OpenPhone() {
  const params = useLocalSearchParams<{ contract?: string }>();
  const insets = useSafeAreaInsets();
  const [contract, setContract] = useState<Contract | null | undefined>(undefined);
  const [me, setMe] = useState<Customer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [option, setOption] = useState<UnlockOption | null>(null);
  const [msisdn, setMsisdn] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('form');
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function load() {
    setLoadError(null);
    try {
      const [all, customer] = await Promise.all([api.contracts(), api.me()]);
      const withOffer = all.filter((c) => c.temporaryUnlock);
      const chosen = withOffer.find((c) => c.id === params.contract) ?? withOffer[0] ?? null;
      setContract(chosen);
      setMe(customer);
      setOption(chosen?.temporaryUnlock?.options[0] ?? null);
      const first = ownNumbers(customer)[0] ?? null;
      setMsisdn(first);
      setNetwork(networkForPhone(first) ?? 'MTN');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your contracts.');
    }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pay() {
    if (!contract || !option) return;
    if (!msisdn || !network) return setError('Choose the number to pay from.');
    setError(null);
    setStage('waiting');
    try {
      const { reference } = await api.startTemporaryUnlock({ contractId: contract.id, percent: option.percent, network, msisdn });
      poll(reference, 0);
    } catch (e) {
      setStage('form');
      setError(e instanceof Error ? e.message : 'The payment could not be started.');
    }
  }

  function poll(reference: string, attempt: number) {
    if (!alive.current) return;
    if (attempt >= PAYMENT_CONFIG.pollMaxAttempts) return setStage('timeout');
    timer.current = setTimeout(async () => {
      try {
        const status = await api.paymentStatus(reference);
        if (!alive.current) return;
        if (status.status === 'SUCCESS' || status.status === 'NEEDS_REVIEW') return setStage('success');
        if (status.status === 'FAILED') return setStage('failed');
      } catch {
        // A check that fails while waiting is expected (a weak signal): keep going.
      }
      poll(reference, attempt + 1);
    }, PAYMENT_CONFIG.pollIntervalMs);
  }

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (stage !== 'form') {
    const content = {
      waiting: { icon: null, color: colors.primary, title: 'Approve on your phone', text: `A Mobile Money prompt for ${formatMoney(option?.amountMinor ?? 0)} has been sent to ${msisdn}. Enter your PIN to approve it.` },
      success: { icon: 'lock-open' as const, color: colors.success, title: 'Your phone is opening', text: `Paid. Your phone opens for ${option?.period} once it is connected to the internet. Pay the rest of what is overdue before then, or it locks again.` },
      failed: { icon: 'close-circle' as const, color: colors.danger, title: 'Payment not completed', text: 'The payment was declined or cancelled. No money was taken, and your phone stays locked.' },
      timeout: { icon: 'time' as const, color: colors.warning, title: 'Still waiting for confirmation', text: 'If you approved the prompt, your phone will open when the payment is confirmed.' },
    }[stage];
    return (
      <View style={styles.status}>
        {content.icon ? <Ionicons name={content.icon} size={72} color={content.color} /> : <ActivityIndicator size="large" color={colors.primary} style={{ marginBottom: 12 }} />}
        <Text style={[styles.statusTitle, { color: content.color }]}>{content.title}</Text>
        <Text style={styles.statusText}>{content.text}</Text>
        <View style={{ alignSelf: 'stretch', marginTop: 28, gap: 10 }}>
          {stage === 'success' && <Button title="Done" onPress={close} />}
          {(stage === 'failed' || stage === 'timeout') && <Button title="Try again" onPress={() => setStage('form')} />}
          {stage !== 'success' && stage !== 'waiting' && <Button title="Close" variant="outline" onPress={close} />}
        </View>
      </View>
    );
  }
  if (loadError) return <View style={{ padding: 16 }}><ErrorBanner message={loadError} onRetry={load} /></View>;
  if (contract === undefined) return <Loading />;
  const offer = contract?.temporaryUnlock;
  if (!contract || !offer) return <EmptyState icon="checkmark-circle-outline" title="Nothing to open" hint="None of your phones is locked for a late payment." />;
  if (!offer.available) return <EmptyState icon="lock-closed-outline" title="Temporary unlock is not available" hint={offer.message ?? ''} />;
  const numbers = me ? ownNumbers(me) : [];

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        <Card>
          <Text style={styles.muted}>Overdue</Text>
          <Text style={styles.amount}>{formatMoney(offer.overdueMinor)}</Text>
          <Text style={styles.muted}>
            {offer.activeUntil ? `Your phone is open until ${formatDateTime(offer.activeUntil)}. ` : ''}
            {offer.usesLeft} temporary unlock{offer.usesLeft === 1 ? '' : 's'} left
          </Text>
        </Card>

        <Text style={styles.label}>How long do you need?</Text>
        {offer.options.map((o) => {
          const chosen = option?.percent === o.percent;
          return (
            <Pressable key={o.percent} onPress={() => setOption(o)} accessibilityRole="radio" accessibilityState={{ selected: chosen }} style={[styles.option, chosen && styles.optionChosen]}>
              <Ionicons name={chosen ? 'radio-button-on' : 'radio-button-off'} size={22} color={chosen ? colors.primary : colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle}>Open for {o.period}</Text>
                <Text style={styles.muted}>{o.percent}% of what is overdue</Text>
              </View>
              <Text style={styles.optionAmount}>{formatMoney(o.amountMinor)}</Text>
            </Pressable>
          );
        })}

        <Text style={styles.label}>Pay from</Text>
        {numbers.length === 0 ? (
          <Text style={styles.problem}>There is no Mobile Money number on your account. Please call customer service.</Text>
        ) : (
          <View style={styles.wrap}>
            {numbers.map((n) => <Chip key={n} label={n} selected={msisdn === n} onPress={() => { setMsisdn(n); setNetwork(networkForPhone(n) ?? network); }} />)}
          </View>
        )}
        <View style={styles.wrap}>
          {PAYMENT_CONFIG.networks.map((n) => <Chip key={n.value} label={n.label} selected={network === n.value} onPress={() => setNetwork(n.value)} />)}
        </View>

        <View style={styles.note}>
          <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
          <Text style={styles.noteText}>Your phone locks again when the time is up, unless you have paid everything that is overdue.</Text>
        </View>
        {error ? <Text style={styles.problem}>{error}</Text> : null}
      </ScrollView>
      <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]}>
        <Button title={option ? `Pay ${formatMoney(option.amountMinor)} and open` : 'Choose an option'} onPress={pay} disabled={!option || numbers.length === 0} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 16, marginBottom: 8 },
  muted: { fontSize: 13, color: colors.textMuted },
  amount: { fontSize: 28, fontWeight: '800', color: colors.danger, marginVertical: 2 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.white, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1.5, borderColor: 'transparent' },
  optionChosen: { borderColor: colors.primary },
  optionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  optionAmount: { fontSize: 16, fontWeight: '800', color: colors.text },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  problem: { color: colors.danger, fontSize: 13, marginTop: 8 },
  note: { flexDirection: 'row', gap: 8, backgroundColor: colors.primarySoft, borderRadius: 12, padding: 12, marginTop: 16 },
  noteText: { flex: 1, fontSize: 13, color: colors.primary },
  bar: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  status: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  statusTitle: { fontSize: 22, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  statusText: { fontSize: 15, color: colors.text, marginTop: 8, textAlign: 'center' },
});
