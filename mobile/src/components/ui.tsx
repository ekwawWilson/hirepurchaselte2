import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../constants/colors';

export const shadow = {
  shadowColor: '#0F172A',
  shadowOpacity: 0.06,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 2,
};

export function Card({ children, style, onPress, accessibilityLabel }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accessibilityLabel?: string }) {
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.card, style, pressed && { opacity: 0.85 }]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Pill({ label, color, background }: { label: string; color: string; background: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: background }]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function ProgressBar({ value, color = colors.success }: { value: number; color?: string }) {
  return (
    <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <View style={[styles.fill, { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, backgroundColor: color }]} />
    </View>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {action}
    </View>
  );
}

export function EmptyState({ icon, title, hint }: { icon: keyof typeof Ionicons.glyphMap; title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={40} color={colors.border} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, disabled, loading, variant = 'primary', icon, style }: {
  title: string; onPress: () => void; disabled?: boolean; loading?: boolean;
  variant?: 'primary' | 'danger' | 'outline'; icon?: keyof typeof Ionicons.glyphMap; style?: StyleProp<ViewStyle>;
}) {
  const background = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : colors.white;
  const color = variant === 'outline' ? colors.primary : colors.white;
  return (
    <Pressable
      onPress={onPress} disabled={disabled || loading} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => [
        styles.button, { backgroundColor: background }, variant === 'outline' && styles.buttonOutline,
        (disabled || loading) && { opacity: 0.5 }, pressed && { opacity: 0.85 }, style,
      ]}>
      {loading ? <ActivityIndicator color={color} /> : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={color} style={{ marginRight: 8 }} /> : null}
          <Text style={[styles.buttonText, { color }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

/** A small selectable chip: quick amounts, networks, contracts, filters. */
export function Chip({ label, selected, onPress, sublabel }: { label: string; selected: boolean; onPress: () => void; sublabel?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityState={{ selected }}
      style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.chipText, selected && { color: colors.white }]} numberOfLines={1}>{label}</Text>
      {sublabel ? <Text style={[styles.chipSub, selected && { color: colors.white }]} numberOfLines={1}>{sublabel}</Text> : null}
    </Pressable>
  );
}

export function Loading() {
  return <View style={styles.loading}><ActivityIndicator size="large" color={colors.primary} /></View>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Pressable onPress={onRetry} style={styles.errorBanner} accessibilityRole="button" accessibilityLabel={`${message} Tap to try again`}>
      <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
      <Text style={styles.errorText}>{message} Tap to try again.</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, ...shadow },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '600' },
  track: { height: 8, borderRadius: 999, backgroundColor: colors.border, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 999 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, marginBottom: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginTop: 10 },
  emptyHint: { fontSize: 13, color: colors.textMuted, marginTop: 4, textAlign: 'center' },
  button: { minHeight: 48, borderRadius: 12, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  buttonOutline: { borderWidth: 1.5, borderColor: colors.primary },
  buttonText: { fontSize: 16, fontWeight: '700' },
  chip: { borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.white, paddingHorizontal: 14, paddingVertical: 9, marginRight: 8, marginBottom: 8, minHeight: 44, justifyContent: 'center' },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.text },
  chipSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.dangerSoft, borderRadius: 12, padding: 12, marginBottom: 12 },
  errorText: { flex: 1, color: colors.danger, fontSize: 13 },
});
