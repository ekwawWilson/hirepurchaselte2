import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSession } from '../lib/session';
import { colors } from '../constants/colors';
import { APP_CONFIG } from '../constants/config';
import { Button } from '../components/ui';
import { SupportFooter } from '../components/SupportFooter';
import { inputStyles } from '../components/inputStyles';

// Bundled, so it shows offline and before the server answers.
const LOGO = require('../../assets/logo.png');

/** Phone number and password. The server's own message is shown when it refuses. */
export default function SignIn() {
  const { signIn, org } = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!phone.trim() || !password) {
      setError('Enter your phone number and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(phone.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Image source={LOGO} style={styles.logo} resizeMode="contain" accessibilityLabel={org.companyName} />
          </View>
          <Text style={styles.title}>Customer Portal</Text>
          <Text style={styles.subtitle}>Sign in to see what you owe and pay it.</Text>

          <Text style={inputStyles.label}>Phone number</Text>
          <TextInput
            style={inputStyles.input} value={phone} onChangeText={setPhone} placeholder="024XXXXXXX"
            keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={16}
          />
          <Text style={inputStyles.label}>Password</Text>
          <View>
            <TextInput
              style={[inputStyles.input, { paddingRight: 48 }]} value={password} onChangeText={setPassword} secureTextEntry={!show}
              autoCapitalize="none" autoComplete="current-password" textContentType="password" onSubmitEditing={submit} returnKeyType="go"
            />
            <Pressable onPress={() => setShow(!show)} style={inputStyles.eye} hitSlop={8} accessibilityRole="button" accessibilityLabel={show ? 'Hide password' : 'Show password'}>
              <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          {error ? <Text style={inputStyles.error}>{error}</Text> : null}
          <Button title="Sign in" onPress={submit} loading={busy} style={{ marginTop: 20 }} />
          <Link href="/reset-password" asChild>
            <Pressable style={styles.forgot} hitSlop={8} accessibilityRole="link">
              <Text style={styles.forgotText}>Forgot password?</Text>
            </Pressable>
          </Link>
          <Text style={styles.hint}>No password yet? Staff give you one when you buy. Ask at the shop or call us.</Text>
          <SupportFooter />
          <Text style={styles.version}>{APP_CONFIG.appName} {APP_CONFIG.version}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 40 },
  // Black, as the logo itself and the splash screen are.
  brand: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#000000', borderRadius: 20, paddingVertical: 22, paddingHorizontal: 16 },
  logo: { width: '100%', height: 96 },
  title: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 22, textAlign: 'center' },
  subtitle: { fontSize: 14, color: colors.textMuted, marginTop: 4, marginBottom: 8, textAlign: 'center' },
  forgot: { alignSelf: 'center', marginTop: 16, minHeight: 32, justifyContent: 'center' },
  forgotText: { color: colors.primary, fontWeight: '600', fontSize: 15 },
  hint: { textAlign: 'center', color: colors.textMuted, fontSize: 13, marginTop: 8 },
  version: { textAlign: 'center', color: colors.textMuted, fontSize: 11 },
});
