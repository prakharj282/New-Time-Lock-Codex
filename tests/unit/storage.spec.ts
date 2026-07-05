import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ALWAYS_LOCKED_UNTIL,
  formatScheduleDays,
  getActiveSlotForNow,
  getNextScheduleEvent,
  getNextUpcomingSlot,
  getResponseError,
  getScheduleByDay,
  getScheduleState,
  getScheduleSummary,
  getSlotsForDay,
  isAlwaysLocked,
  isWithinSchedule,
  type NoteSchedule,
} from '../../src/utils/storage';

const mondaySchedule: NoteSchedule = {
  enabled: true,
  days: [1],
  slots: [{ start: '09:00', end: '17:00' }],
};

describe('storage and schedule helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('detects always locked notes', () => {
    expect(isAlwaysLocked({ lockedUntil: ALWAYS_LOCKED_UNTIL })).toBe(true);
    expect(isAlwaysLocked({ lockedUntil: ALWAYS_LOCKED_UNTIL - 1 })).toBe(false);
    expect(isAlwaysLocked({ lockedUntil: null })).toBe(false);
  });

  test('returns per-day slots before legacy shared slots', () => {
    const schedule: NoteSchedule = {
      enabled: true,
      days: [1],
      slots: [{ start: '09:00', end: '17:00' }],
      perDay: {
        1: [{ start: '10:00', end: '11:00' }],
      },
    };

    expect(getSlotsForDay(schedule, 1)).toEqual([{ start: '10:00', end: '11:00' }]);
    expect(getSlotsForDay(schedule, 2)).toEqual([]);
  });

  test('detects active, break, and off-today schedule states', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 10, 30, 0));
    expect(isWithinSchedule(mondaySchedule)).toBe(true);
    expect(getScheduleState(mondaySchedule)).toBe('locked');
    expect(getActiveSlotForNow(mondaySchedule)).toEqual({ start: '09:00', end: '17:00' });

    vi.setSystemTime(new Date(2026, 0, 5, 18, 0, 0));
    expect(isWithinSchedule(mondaySchedule)).toBe(false);
    expect(getScheduleState(mondaySchedule)).toBe('break');

    vi.setSystemTime(new Date(2026, 0, 6, 10, 0, 0));
    expect(getScheduleState(mondaySchedule)).toBe('off-today');
  });

  test('handles overnight schedule windows', () => {
    vi.useFakeTimers();
    const schedule: NoteSchedule = {
      enabled: true,
      days: [1],
      slots: [{ start: '22:00', end: '02:00' }],
    };

    vi.setSystemTime(new Date(2026, 0, 5, 23, 0, 0));
    expect(isWithinSchedule(schedule)).toBe(true);

    vi.setSystemTime(new Date(2026, 0, 5, 3, 0, 0));
    expect(isWithinSchedule(schedule)).toBe(false);
  });

  test('finds next schedule events and upcoming slots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 8, 30, 0));

    expect(getNextScheduleEvent(mondaySchedule)).toMatchObject({
      type: 'lock',
      dayName: 'Monday',
      time: '09:00',
    });
    expect(getNextUpcomingSlot(mondaySchedule)).toEqual({
      dayIndex: 1,
      slot: { start: '09:00', end: '17:00' },
    });

    vi.setSystemTime(new Date(2026, 0, 5, 10, 30, 0));
    expect(getNextScheduleEvent(mondaySchedule)).toMatchObject({
      type: 'unlock',
      dayName: 'Monday',
      time: '17:00',
    });
  });

  test('formats schedule summaries', () => {
    expect(formatScheduleDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(formatScheduleDays([0, 6])).toBe('Weekends');
    expect(formatScheduleDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(getScheduleByDay(mondaySchedule).find(day => day.dayIndex === 1)?.slots).toEqual(mondaySchedule.slots);
    expect(getScheduleSummary(mondaySchedule)).toContain('Mon');
    expect(getScheduleSummary(mondaySchedule)).toContain('09:00');
  });

  test('turns API error payloads into useful messages', () => {
    expect(getResponseError({ missingEnv: ['DATABASE_URL', 'ENCRYPTION_KEY'] }, 503)).toBe(
      'Missing server configuration: DATABASE_URL, ENCRYPTION_KEY'
    );
    expect(getResponseError({ error: 'Failed to save note' }, 500)).toBe('Failed to save note');
    expect(getResponseError({}, 404)).toContain('API route not found');
    expect(getResponseError({}, 413)).toBe('Photo is too large for Vercel. Retake or choose a smaller image.');
    expect(getResponseError({}, 418)).toBe('API error: 418');
  });
});
