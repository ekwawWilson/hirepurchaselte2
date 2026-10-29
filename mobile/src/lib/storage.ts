import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Customer } from './types';

/**
 * The sign-in token lives only in the encrypted SecureStore; the profile
 * (nothing secret: name, number) is cached in AsyncStorage so the app opens
 * signed in without waiting on the network. Both are cleared together.
 */
const TOKEN_KEY = 'flezepay.token';
const CUSTOMER_KEY = 'flezepay.customer';

export const getToken = () => SecureStore.getItemAsync(TOKEN_KEY);
export const setToken = (token: string) => SecureStore.setItemAsync(TOKEN_KEY, token);

export async function getCachedCustomer(): Promise<Customer | null> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOMER_KEY);
    return raw ? (JSON.parse(raw) as Customer) : null;
  } catch {
    return null;
  }
}

export const cacheCustomer = (customer: Customer) => AsyncStorage.setItem(CUSTOMER_KEY, JSON.stringify(customer));

export async function clearSession() {
  await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), AsyncStorage.removeItem(CUSTOMER_KEY)]);
}
