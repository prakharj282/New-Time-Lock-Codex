import { describe, expect, test } from 'vitest';
import { generateGibberish } from '../../src/utils/gibberish';

describe('gibberish generation', () => {
  test('generates exact-length emergency text', () => {
    expect(generateGibberish(20)).toHaveLength(20);
    expect(generateGibberish(250)).toHaveLength(250);
  });

  test('uses only allowed emergency characters', () => {
    expect(generateGibberish(200)).toMatch(/^[A-Za-z0-9!@#$%&*+?]+$/);
  });

  test('returns an empty string for zero length', () => {
    expect(generateGibberish(0)).toBe('');
  });
});
