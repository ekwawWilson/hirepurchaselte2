import { ScrollView, StyleSheet, Text, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { colors } from '../constants/colors';
import { PasswordForm } from '../components/PasswordForm';

/**
 * First sign-in on the temporary password staff gave: the customer chooses
 * their own before anything else, as the web portal requires.
 */
export default function ChoosePassword() {
  const { customer, passwordChanged, signOut } = useSession();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Welcome, {customer?.firstName}</Text>
        <Text style={styles.text}>You signed in with a temporary password. Choose your own to continue. It must not be your phone number.</Text>
        <PasswordForm
          withCurrent
          submitLabel="Save and continue"
          onSubmit={async (current, next) => {
            const { token } = await api.changePassword(current, next);
            await passwordChanged(token);
          }}
        />
        <Pressable onPress={() => void signOut()} style={styles.out} hitSlop={8} accessibilityRole="button">
          <Text style={styles.outText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800', color: colors.text, marginTop: 24 },
  text: { fontSize: 14, color: colors.textMuted, marginTop: 6 },
  out: { alignSelf: 'center', marginTop: 20, minHeight: 32, justifyContent: 'center' },
  outText: { color: colors.textMuted, fontWeight: '600' },
});
