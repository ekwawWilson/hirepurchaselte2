import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from './ui';
import { inputStyles } from './inputStyles';

/** The server's rule (MIN_PORTAL_PASSWORD_LENGTH); it also refuses one of your own phone numbers. */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Current password (unless `withCurrent` is false), new password and its
 * confirmation. Checks the two match and the length before calling
 * `onSubmit`; anything else the server refuses is shown as it says it.
 */
export function PasswordForm({ withCurrent, submitLabel, onSubmit }: {
  withCurrent: boolean;
  submitLabel: string;
  onSubmit: (current: string, next: string) => Promise<string | void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setDone(null);
    if (withCurrent && !current) return setError('Enter your current password.');
    if (next.length < MIN_PASSWORD_LENGTH) return setError(`Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (next !== confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    try {
      const message = await onSubmit(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      if (message) setDone(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      {withCurrent && (
        <>
          <Text style={inputStyles.label}>Current password</Text>
          <TextInput style={inputStyles.input} value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" autoComplete="current-password" />
        </>
      )}
      <Text style={inputStyles.label}>New password</Text>
      <TextInput style={inputStyles.input} value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" />
      <Text style={inputStyles.label}>Confirm new password</Text>
      <TextInput style={inputStyles.input} value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" autoComplete="new-password" onSubmitEditing={submit} />
      {error ? <Text style={inputStyles.error}>{error}</Text> : null}
      {done ? <Text style={inputStyles.success}>{done}</Text> : null}
      <Button title={submitLabel} onPress={submit} loading={busy} style={{ marginTop: 18 }} />
    </View>
  );
}
