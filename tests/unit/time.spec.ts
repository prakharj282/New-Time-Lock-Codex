import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  calculateFutureTimestamp,
  calculateTimestampForDateTime,
  fetchNetworkTime,
  formatUnlockTime,
} from '../../src/utils/time';

describe('time helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('calculates duration lock timestamps from current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 10, 0, 0));

    expect(calculateFutureTimestamp(2, 30)).toBe(Date.now() + 9_000_000);
  });

  test('parses datetime-local values as timestamps', () => {
    const expected = new Date('2026-01-05T12:45').getTime();

    expect(calculateTimestampForDateTime('2026-01-05T12:45')).toBe(expected);
  });

  test('formats unlock time for display', () => {
    const formatted = formatUnlockTime(new Date(2026, 0, 5, 9, 7).getTime());

    expect(formatted).toContain('Jan');
    expect(formatted).toContain('5');
    expect(formatted).toContain('09:07');
  });

  test('fetches network time from fallback source when first source fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ dateTime: '2026-01-05T00:00:00' }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchNetworkTime()).toBe(new Date('2026-01-05T00:00:00Z').getTime());
  });

  test('returns null when network time sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await fetchNetworkTime()).toBeNull();
  });
});
