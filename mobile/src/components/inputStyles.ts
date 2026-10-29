import { StyleSheet } from 'react-native';
import { colors } from '../constants/colors';

/** The forms' shared look: sign-in, reset, choose and change password, Pay. */
export const inputStyles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginTop: 14, marginBottom: 6 },
  input: {
    minHeight: 50, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.white,
    paddingHorizontal: 14, fontSize: 16, color: colors.text,
  },
  eye: { position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' },
  error: { color: colors.danger, fontSize: 14, marginTop: 12 },
  success: { color: colors.success, fontSize: 14, marginTop: 12 },
});
