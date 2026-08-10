import { describe, expect, test } from 'vitest';
import {
  isValidPartnerPin,
  sanitizePartnerPin,
} from '../../src/utils/accountability';

describe('accountability partner PIN helpers', () => {
  test('accepts exactly six digits and preserves leading zeroes', () => {
    expect(isValidPartnerPin('012345')).toBe(true);
    expect(sanitizePartnerPin('012345')).toBe('012345');
  });

  test.each([
    '',
    '12345',
    '1234567',
    '12 345',
    '12345a',
    '１２３４５６',
  ])('rejects invalid PIN %j', (pin) => {
    expect(isValidPartnerPin(pin)).toBe(false);
  });

  test('sanitizes pasted input to the first six ASCII digits', () => {
    expect(sanitizePartnerPin('01-23 4567')).toBe('012345');
    expect(sanitizePartnerPin('abc')).toBe('');
  });
});
