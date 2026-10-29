import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useLoad } from '../../lib/useLoad';
import { colors } from '../../constants/colors';
import { APP_CONFIG } from '../../constants/config';
import { Button, Card, SectionTitle } from '../../components/ui';
import { PasswordForm } from '../../components/PasswordForm';
import { SupportFooter } from '../../components/SupportFooter';

/** The customer's details (read only), changing their password, and signing out. */
export default function Profile() {
  const insets = useSafeAreaInsets();
  const { customer: cached, signOut, passwordChanged } = useSession();
  const { data } = useLoad(api.me);
  const customer = data ?? cached;

  function confirmSignOut() {
    Alert.alert('Log out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Profile</Text>
      <SectionTitle>Personal information</SectionTitle>
      <Card>
        <Row label="Name" value={customer ? `${customer.firstName} ${customer.lastName}` : '—'} />
        <Row label="Member ID" value={customer?.membershipId ?? '—'} />
        <Row label="Phone" value={[customer?.phone, customer?.phone2, customer?.phone3].filter(Boolean).join(', ') || '—'} />
        {customer?.email ? <Row label="Email" value={customer.email} /> : null}
        {customer?.address ? <Row label="Address" value={customer.address} /> : null}
        {customer?.branch ? <Row label="Branch" value={customer.branch.name} /> : null}
      </Card>
      <Text style={styles.hint}>To change these details, call us or visit your branch.</Text>

      <SectionTitle>Change password</SectionTitle>
      <Card>
        <PasswordForm
          withCurrent
          submitLabel="Change password"
          onSubmit={async (current, next) => {
            const { token } = await api.changePassword(current, next);
            await passwordChanged(token);
            return 'Your password has been changed. You stay signed in on this phone.';
          }}
        />
      </Card>

      <SectionTitle>Account</SectionTitle>
      <Card>
        <Row label="App version" value={APP_CONFIG.version} />
        <Button title="Log out" variant="outline" icon="log-out-outline" onPress={confirmSignOut} style={{ marginTop: 12 }} />
      </Card>
      <SupportFooter />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 24, fontWeight: '800', color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, gap: 12 },
  label: { fontSize: 13, color: colors.textMuted },
  value: { fontSize: 14, fontWeight: '600', color: colors.text, flexShrink: 1, textAlign: 'right' },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 6, marginLeft: 4 },
});
