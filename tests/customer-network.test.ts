import { describe, it, expect } from 'vitest';
import { networkForPhone } from '@/lib/constants/customers';

describe('networkForPhone', () => {
  it('reads the network from a Ghana number in any written form', () => {
    expect(networkForPhone('0244123456')).toBe('MTN');
    expect(networkForPhone('233 55 123 4567')).toBe('MTN');
    expect(networkForPhone('+233201234567')).toBe('TELECEL');
    expect(networkForPhone('050-123-4567')).toBe('TELECEL');
    expect(networkForPhone('0271234567')).toBe('AIRTELTIGO');
    expect(networkForPhone('0561234567')).toBe('AIRTELTIGO');
  });

  it('returns null for a prefix no mobile network uses', () => {
    expect(networkForPhone('0302123456')).toBeNull();
  });
});
