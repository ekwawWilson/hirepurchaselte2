import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { api } from '../lib/api';
import { colors } from '../constants/colors';
import { Button } from '../components/ui';
import { PasswordForm } from '../components/PasswordForm';
import { SupportFooter } from '../components/SupportFooter';
import { inputStyles } from '../components/inputStyles';

/**
 * Forgot password, in two steps on one screen: the phone number, then the
 * code texted to it with a new password. The first answer is the same for a
 * number nobody has, so it never says who is a customer.
 */
export default function ResetPassword() {
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    if (!phone.trim()) return setError('Enter your phone number.');
    setBusy(true);
    setError(null);
    try {
      const { message } = await api.requestReset(phone.trim());
      Alert.alert('Check your messages', message);
      setStep('code');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 24 }} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back to sign in">
            <Ionicons name="arrow-back" size={22} color={colors.primary} />
            <Text style={styles.backText}>Sign in</Text>
          </Pressable>
          <Text style={styles.title}>Reset your password</Text>
          <Text style={styles.text}>
            {step === 'phone'
              ? 'Enter the phone number you registered with. We will text you a 6-digit code.'
              : `Enter the code sent to ${phone.trim()} and choose a new password. The code expires in 10 minutes.`}
          </Text>

          <Text style={inputStyles.label}>Phone number</Text>
          <TextInput style={inputStyles.input} value={phone} onChangeText={setPhone} placeholder="024XXXXXXX" keyboardType="phone-pad" editable={step === 'phone'} maxLength={16} />

          {step === 'phone' ? (
            <>
              {error ? <Text style={inputStyles.error}>{error}</Text> : null}
              <Button title="Send code" onPress={sendCode} loading={busy} style={{ marginTop: 18 }} />
            </>
          ) : (
            <>
              <Text style={inputStyles.label}>Code</Text>
              <TextInput style={inputStyles.input} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" textContentType="oneTimeCode" placeholder="123456" />
              <PasswordForm
                withCurrent={false}
                submitLabel="Set new password"
                onSubmit={async (_current, next) => {
                  if (!/^\d{6}$/.test(code.trim())) throw new Error('Enter the 6-digit code from the SMS.');
                  const { message } = await api.resetPassword(phone.trim(), code.trim(), next);
                  Alert.alert('Password changed', message, [{ text: 'Sign in', onPress: () => router.replace('/sign-in') }]);
                }}
              />
              <Pressable onPress={() => { setStep('phone'); setCode(''); }} style={styles.again} hitSlop={8}>
                <Text style={styles.backText}>Didn&apos;t get a code? Send another</Text>
              </Pressable>
            </>
          )}
          <SupportFooter />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16, minHeight: 36 },
  backText: { color: colors.primary, fontWeight: '600', fontSize: 15 },
  title: { fontSize: 24, fontWeight: '800', color: colors.text },
  text: { fontSize: 14, color: colors.textMuted, marginTop: 6 },
  again: { alignSelf: 'center', marginTop: 16, minHeight: 32, justifyContent: 'center' },
});
