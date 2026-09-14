import { describe, it, expect } from 'vitest';
import { referencePrefix } from '@/lib/utils/idGenerators';

describe('referencePrefix', () => {
  it('takes the initials of up to three words', () => {
    expect(referencePrefix('Accra Mobile Finance')).toBe('AMF');
    expect(referencePrefix('PETROS Hirepurchase')).toBe('PH');
    expect(referencePrefix('Kumasi Phone Credit Services Ltd')).toBe('KPC');
  });

  it('splits a joined name on its capitals, else uses two letters', () => {
    expect(referencePrefix('FlezePay')).toBe('FP');
    expect(referencePrefix('flezepay')).toBe('FL');
  });

  it('keeps only letters, and falls back to HP when there are none', () => {
    expect(referencePrefix('K & B Mobiles')).toBe('KBM');
    expect(referencePrefix('123')).toBe('HP');
  });
});
