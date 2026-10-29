import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { colors } from '../constants/colors';
import { PAYMENT_CONFIG } from '../constants/config';
import { Button, Card, Chip, EmptyState, ErrorBanner, Loading } from '../components/ui';
import { inputStyles } from '../components/inputStyles';
import {
  amountProblem, coverageText, defaultAmount, dueNowMinor, formatMoney, isLoan, isPayable, isSavings, networkForPhone, normalisePhone, parseAmount, quickAmounts,
} from '../lib/due';
import { contractTitle, formatDate } from '../lib/format';
import type { Contract, ContractDetail, Customer } from '../lib/types';

type Stage = 'form' | 'waiting' | 'success' | 'failed' | 'timeout';

/**
 * Paying a contract by Mobile Money. Opened from the centre button (no
 * contract chosen), a contract card or page, Home, or a
 * flezepay://pay?contract=… link. The prompt can only go to one of the
 * customer's own registered numbers (the server enforces it), and nothing is
 * shown as paid until the server says so.
 */
export default function Pay() {
  const params = useLocalSearchParams<{ contract?: string }>();
  const insets = useSafeAreaInsets();
  const { refreshCustomer } = useSession();
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [me, setMe] = useState<Customer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [amountText, setAmountText] = useState('');
  const [msisdn, setMsisdn] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('form');
  const [reference, setReference] = useState<string | null>(null);
  const [paidMinor, setPaidMinor] = useState(0);
  const [recorded, setRecorded] = useState(true);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Polling stops the moment the screen is left.
  useEffect(() => () => {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function load() {
    setLoadError(null);
    try {
      const [all, customer] = await Promise.all([api.contracts(), api.me()]);
      const payable = all.filter(isPayable);
      setContracts(payable);
      setMe(customer);
      void refreshCustomer().catch(() => undefined);
      const chosen = payable.find((c) => c.id === params.contract) ?? payable.find((c) => dueNowMinor(c) > 0) ?? payable[0] ?? null;
      choose(chosen);
      const numbers = ownNumbers(customer);
      setMsisdn(numbers[0] ?? null);
      setNetwork(networkForPhone(numbers[0]) ?? 'MTN');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your contracts.');
    }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(c: Contract | null) {
    setSelectedId(c?.id ?? null);
    setDetail(null);
    setError(null);
    const preset = c ? defaultAmount(c) : null;
    setAmountText(preset ? (preset / 100).toFixed(2).replace(/\.00$/, '') : '');
    if (c && !isSavings(c) && !isLoan(c)) api.contract(c.id).then((d) => alive.current && setDetail(d)).catch(() => undefined);
  }

  const selected = contracts?.find((c) => c.id === selectedId) ?? null;
  const amountMinor = parseAmount(amountText);
  const chips = selected ? quickAmounts(selected) : [];
  const problem = selected && amountText ? amountProblem(selected, amountMinor, PAYMENT_CONFIG.minPaymentMinor, PAYMENT_CONFIG.maxSavingsPaymentMinor) : null;
  const coverage = selected && !problem ? coverageText(selected, detail?.instalments ?? null, amountMinor) : null;
  const numbers = useMemo(() => (me ? ownNumbers(me) : []), [me]);

  async function pay() {
    if (!selected) return;
    const issue = amountProblem(selected, amountMinor, PAYMENT_CONFIG.minPaymentMinor, PAYMENT_CONFIG.maxSavingsPaymentMinor);
    if (issue) return setError(issue);
    if (!msisdn || !network) return setError('Choose the number to pay from.');
    setError(null);
    setStage('waiting');
    setPaidMinor(amountMinor);
    try {
      const { reference: ref } = await api.startPayment({ contractId: selected.id, amountMinor, network, msisdn });
      setReference(ref);
      poll(ref, 0);
    } catch (e) {
      setStage('form');
      setError(e instanceof Error ? e.message : 'The payment could not be started.');
    }
  }

  function poll(ref: string, attempt: number) {
    if (!alive.current) return;
    if (attempt >= PAYMENT_CONFIG.pollMaxAttempts) return setStage('timeout');
    timer.current = setTimeout(async () => {
      try {
        const status = await api.paymentStatus(ref);
        if (!alive.current) return;
        if (status.status === 'SUCCESS' || status.status === 'NEEDS_REVIEW') {
          setRecorded(status.recorded && status.status === 'SUCCESS');
          return setStage('success');
        }
        if (status.status === 'FAILED') return setStage('failed');
      } catch {
        // A check that fails while waiting is expected (a weak signal): keep going.
      }
      poll(ref, attempt + 1);
    }, PAYMENT_CONFIG.pollIntervalMs);
  }

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (stage !== 'form') {
    return (
      <StatusView
        stage={stage} amountMinor={paidMinor} msisdn={msisdn} reference={reference} recorded={recorded}
        contractNumber={selected?.contractNumber ?? ''} onClose={close} onRetry={() => { setStage('form'); setReference(null); }}
      />
    );
  }
  if (loadError) return <View style={{ padding: 16 }}><ErrorBanner message={loadError} onRetry={load} /></View>;
  if (!contracts) return <Loading />;
  if (contracts.length === 0 || !selected) {
    return <EmptyState icon="checkmark-circle-outline" title="Nothing to pay" hint="You have no contract with anything owed. Thank you!" />;
  }

  const now = dueNowMinor(selected);
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        {contracts.length > 1 && (
          <>
            <Text style={styles.label}>Contract</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
              {contracts.map((c) => (
                <Chip key={c.id} label={contractTitle(c)} sublabel={c.contractNumber} selected={c.id === selectedId} onPress={() => choose(c)} />
              ))}
            </ScrollView>
          </>
        )}

        <Card style={[styles.summary, now > 0 && { borderColor: colors.danger }]}>
          <Text style={styles.muted}>{now > 0 ? 'Due now' : isSavings(selected) ? 'Saved so far' : isLoan(selected) ? 'Owed' : 'Next payment'}</Text>
          <Text style={[styles.summaryAmount, now > 0 && { color: colors.danger }]}>
            {formatMoney(now > 0 ? now : isSavings(selected) ? selected.totalPaidMinor : isLoan(selected) ? selected.due.totalDueMinor ?? 0 : selected.due.nextDueMinor)}
          </Text>
          <Text style={styles.small}>
            {isSavings(selected) ? 'Pay in any amount' : [
              selected.due.overdueCount > 0 ? `${selected.due.overdueCount} overdue` : null,
              !now && selected.due.nextDueDate ? `due ${formatDate(selected.due.nextDueDate)}` : null,
              `${formatMoney(selected.due.totalDueMinor ?? 0)} balance`,
            ].filter(Boolean).join(' · ')}
          </Text>
        </Card>

        <Text style={styles.label}>Amount</Text>
        <View style={styles.wrap}>
          {chips.map((q) => (
            <Chip key={q.label} label={q.label} sublabel={formatMoney(q.amountMinor)} selected={amountMinor === q.amountMinor}
              onPress={() => setAmountText((q.amountMinor / 100).toFixed(2).replace(/\.00$/, ''))} />
          ))}
        </View>
        {!isLoan(selected) && (
          <View>
            <Text style={styles.prefix}>GH₵</Text>
            <TextInput style={[inputStyles.input, styles.amountInput]} value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad" placeholder="0.00" accessibilityLabel="Amount in cedis" />
          </View>
        )}
        {problem ? <Text style={styles.problem}>{problem}</Text> : coverage ? <Text style={styles.coverage}>{coverage}</Text> : null}

        <Text style={styles.label}>Pay from</Text>
        {numbers.length === 0 ? (
          <Text style={styles.problem}>There is no Mobile Money number on your account. Please call customer service.</Text>
        ) : (
          <View style={styles.wrap}>
            {numbers.map((n) => (
              <Chip key={n} label={n} selected={msisdn === n} onPress={() => { setMsisdn(n); setNetwork(networkForPhone(n) ?? network); }} />
            ))}
          </View>
        )}
        <View style={styles.wrap}>
          {PAYMENT_CONFIG.networks.map((n) => <Chip key={n.value} label={n.label} selected={network === n.value} onPress={() => setNetwork(n.value)} />)}
        </View>

        <View style={styles.note}>
          <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
          <Text style={styles.noteText}>You will get a prompt on your phone. Enter your Mobile Money PIN to approve. Payments clear late charges and overdue instalments first.</Text>
        </View>
        {error ? <Text style={styles.problem}>{error}</Text> : null}
      </ScrollView>
      <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]}>
        <Button
          title={Number.isFinite(amountMinor) && amountMinor > 0 ? `Pay ${formatMoney(amountMinor)}` : 'Pay'}
          onPress={pay} disabled={!!problem || !(amountMinor > 0) || numbers.length === 0}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

/** The customer's registered numbers, as the server will accept them. */
function ownNumbers(c: Customer): string[] {
  return [...new Set([c.phone, c.phone2, c.phone3].map((p) => normalisePhone(p) ?? p?.trim() ?? null).filter((p): p is string => !!p))];
}

function StatusView({ stage, amountMinor, msisdn, reference, recorded, contractNumber, onClose, onRetry }: {
  stage: Exclude<Stage, 'form'>; amountMinor: number; msisdn: string | null; reference: string | null; recorded: boolean;
  contractNumber: string; onClose: () => void; onRetry: () => void;
}) {
  const content = {
    waiting: { icon: null, color: colors.primary, title: 'Approve on your phone', text: `A Mobile Money prompt for ${formatMoney(amountMinor)} has been sent to ${msisdn}. Enter your PIN to approve it.` },
    success: {
      icon: 'checkmark-circle' as const, color: colors.success, title: 'Payment successful',
      text: recorded ? `${formatMoney(amountMinor)} has been paid on ${contractNumber}. Thank you!` : `${formatMoney(amountMinor)} was received. It is being applied to ${contractNumber}. Thank you!`,
    },
    failed: { icon: 'close-circle' as const, color: colors.danger, title: 'Payment not completed', text: 'The payment was declined or cancelled. No money was taken.' },
    timeout: { icon: 'time' as const, color: colors.warning, title: 'Still waiting for confirmation', text: 'If you approved the prompt, your payment will show in Payments shortly.' },
  }[stage];
  return (
    <View style={styles.status}>
      {content.icon ? <Ionicons name={content.icon} size={72} color={content.color} /> : <ActivityIndicator size="large" color={colors.primary} style={{ marginBottom: 12 }} />}
      <Text style={[styles.statusTitle, { color: content.color }]}>{content.title}</Text>
      <Text style={styles.statusText}>{content.text}</Text>
      {reference ? <Text style={styles.ref}>Reference {reference}</Text> : null}
      <View style={{ alignSelf: 'stretch', marginTop: 28, gap: 10 }}>
        {stage === 'success' && <Button title="Done" onPress={onClose} />}
        {(stage === 'failed' || stage === 'timeout') && <Button title="Try again" onPress={onRetry} />}
        {stage === 'failed' && <Button title="Close" variant="outline" onPress={onClose} />}
        {stage === 'timeout' && <Button title="Close — I'll check later" variant="outline" onPress={onClose} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 16, marginBottom: 8 },
  muted: { fontSize: 13, color: colors.textMuted },
  small: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  summary: { marginTop: 8, borderWidth: 1.5, borderColor: 'transparent' },
  summaryAmount: { fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 2 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  prefix: { position: 'absolute', left: 14, top: 0, bottom: 0, textAlignVertical: 'center', lineHeight: 50, fontSize: 16, fontWeight: '700', color: colors.textMuted, zIndex: 1 },
  amountInput: { paddingLeft: 52, fontSize: 20, fontWeight: '700' },
  problem: { color: colors.danger, fontSize: 13, marginTop: 8 },
  coverage: { color: colors.success, fontSize: 13, marginTop: 8, fontWeight: '600' },
  note: { flexDirection: 'row', gap: 8, backgroundColor: colors.primarySoft, borderRadius: 12, padding: 12, marginTop: 16 },
  noteText: { flex: 1, fontSize: 13, color: colors.primary },
  bar: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  status: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  statusTitle: { fontSize: 22, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  statusText: { fontSize: 15, color: colors.text, marginTop: 8, textAlign: 'center' },
  ref: { fontSize: 12, color: colors.textMuted, marginTop: 14 },
});
