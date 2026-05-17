export interface ScheduleSlot {
  start: string;
  end: string;
}

export interface NoteSchedule {
  enabled: boolean;
  days: number[];
  slots: ScheduleSlot[];
  perDay?: Record<number, ScheduleSlot[]>;
  timezone?: string;
}

export const ALWAYS_LOCKED_UNTIL = 253402300800000;

export function isAlwaysLocked(note: { lockedUntil: number | null }): boolean {
  return !!note.lockedUntil && note.lockedUntil >= ALWAYS_LOCKED_UNTIL;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  lockedUntil: number | null;
  emergencyLength: number | null;
  hideTypos: boolean;
  emergencyOpenEnabled: boolean;
  emergencyOpenPerWeek: number;
  emergencyOpenLog: number[];
  schedule?: NoteSchedule;
  updatedAt?: number;
  deletedAt?: number | null;
  restricted?: boolean;
}

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function getNotes(): Promise<Note[]> {
  return api('/notes');
}

export async function getNoteContent(id: string): Promise<string> {
  const data = await api(`/notes/${id}/content`);
  return data.content || '';
}

export async function saveNote(note: Note, rawContent: string): Promise<{ success: boolean; note?: Note }> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const data = await api(`/notes/${note.id}`, {
    method: 'PUT',
    body: JSON.stringify({ note, rawContent, timezone }),
  });
  return data;
}

export async function updateTitle(id: string, title: string): Promise<{ success: boolean; note?: Note }> {
  const data = await api(`/notes/${id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return data;
}

export async function deleteNote(id: string): Promise<boolean> {
  const data = await api(`/notes/${id}`, { method: 'DELETE' });
  return data.success;
}

export async function extendLock(id: string, additionalMs: number): Promise<number | false> {
  const data = await api(`/notes/${id}/extend-lock`, {
    method: 'POST',
    body: JSON.stringify({ additionalMs }),
  });
  return data.success ? data.lockedUntil : false;
}

export async function setEmergencyLength(id: string, newLength: number): Promise<number | false> {
  const data = await api(`/notes/${id}/set-emergency-length`, {
    method: 'POST',
    body: JSON.stringify({ newLength }),
  });
  return data.success ? data.emergencyLength : false;
}

export async function setLockUntil(id: string, timestamp: number): Promise<number | false> {
  const data = await api(`/notes/${id}/set-lock-until`, {
    method: 'POST',
    body: JSON.stringify({ timestamp }),
  });
  return data.success ? data.lockedUntil : false;
}

let _cachedLastKnownTime: number = 0;

export function saveLastKnownTime(): boolean {
  const now = Date.now();
  _cachedLastKnownTime = now;
  api('/time/save', { method: 'POST' }).catch(() => {});
  return true;
}

export function getLastKnownTime(): number {
  return _cachedLastKnownTime;
}

export async function fetchLastKnownTime(): Promise<number> {
  try {
    const data = await api('/time/last-known');
    _cachedLastKnownTime = data.time || 0;
    return _cachedLastKnownTime;
  } catch {
    return _cachedLastKnownTime;
  }
}

export async function emergencyUnlock(id: string): Promise<{ success: boolean; note?: Note; error?: string }> {
  return api(`/notes/${id}/emergency-unlock`, { method: 'POST' });
}

export async function useEmergencyOpen(id: string): Promise<{
  success: boolean;
  error?: string;
  usedThisWeek?: number;
  limit?: number;
  note?: Note;
}> {
  return api(`/notes/${id}/emergency-open`, { method: 'POST' });
}

export function getSlotsForDay(schedule: NoteSchedule, day: number): ScheduleSlot[] {
  if (schedule.perDay && schedule.perDay[day]) {
    return schedule.perDay[day];
  }
  if (schedule.days && schedule.days.includes(day)) {
    return schedule.slots || [];
  }
  return [];
}

export function isWithinSchedule(schedule: NoteSchedule): boolean {
  if (!schedule || !schedule.enabled) return false;

  const now = new Date();
  const todayDay = now.getDay();
  const slots = getSlotsForDay(schedule, todayDay);
  if (slots.length === 0) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const slot of slots) {
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      if (nowMinutes >= startMinutes && nowMinutes < endMinutes) return true;
    } else {
      if (nowMinutes >= startMinutes || nowMinutes < endMinutes) return true;
    }
  }
  return false;
}

export type SchedulePhase = 'locked' | 'break' | 'off-today';

export function getScheduleState(schedule: NoteSchedule): SchedulePhase {
  if (!schedule || !schedule.enabled) return 'off-today';
  const now = new Date();
  const todayDay = now.getDay();
  const slots = getSlotsForDay(schedule, todayDay);
  if (slots.length === 0) return 'off-today';
  if (isWithinSchedule(schedule)) return 'locked';
  return 'break';
}

export function getActiveSlotForNow(schedule: NoteSchedule): ScheduleSlot | null {
  if (!schedule || !schedule.enabled) return null;
  const now = new Date();
  const todayDay = now.getDay();
  const slots = getSlotsForDay(schedule, todayDay);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const slot of slots) {
    const [sH, sM] = slot.start.split(':').map(Number);
    const [eH, eM] = slot.end.split(':').map(Number);
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;
    if (startMin <= endMin) {
      if (nowMinutes >= startMin && nowMinutes < endMin) return slot;
    } else {
      if (nowMinutes >= startMin || nowMinutes < endMin) return slot;
    }
  }
  return null;
}

export interface ScheduleEvent {
  type: 'lock' | 'unlock';
  timeMs: number;
  dayName: string;
  time: string;
}

export function getNextScheduleEvent(schedule: NoteSchedule): ScheduleEvent | null {
  if (!schedule || !schedule.enabled) return null;
  const fullDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  const nowDay = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowSeconds = now.getSeconds();

  for (let offset = 0; offset < 7; offset++) {
    const day = (nowDay + offset) % 7;
    const slots = getSlotsForDay(schedule, day);
    if (slots.length === 0) continue;

    const parsed = slots.map(s => {
      const [sH, sM] = s.start.split(':').map(Number);
      const [eH, eM] = s.end.split(':').map(Number);
      return { start: sH * 60 + sM, end: eH * 60 + eM, raw: s };
    }).sort((a, b) => a.start - b.start);

    for (const p of parsed) {
      const isToday = offset === 0;
      if (p.start <= p.end) {
        if (isToday && nowMinutes >= p.start && nowMinutes < p.end) {
          const diffMin = p.end - nowMinutes;
          const diffMs = (diffMin * 60 - nowSeconds) * 1000;
          return { type: 'unlock', timeMs: diffMs, dayName: fullDayNames[day], time: p.raw.end };
        }
        if (isToday && nowMinutes < p.start) {
          const diffMin = p.start - nowMinutes;
          const diffMs = (diffMin * 60 - nowSeconds) * 1000;
          return { type: 'lock', timeMs: diffMs, dayName: fullDayNames[day], time: p.raw.start };
        }
      } else {
        if (isToday && nowMinutes >= p.start) {
          const minsToMidnight = 1440 - nowMinutes;
          const diffMs = (minsToMidnight * 60 + p.end * 60 - nowSeconds) * 1000;
          return { type: 'unlock', timeMs: diffMs, dayName: fullDayNames[(day + 1) % 7], time: p.raw.end };
        }
        if (isToday && nowMinutes < p.end) {
          const diffMin = p.end - nowMinutes;
          const diffMs = (diffMin * 60 - nowSeconds) * 1000;
          return { type: 'unlock', timeMs: diffMs, dayName: fullDayNames[day], time: p.raw.end };
        }
        if (isToday && nowMinutes < p.start) {
          const diffMin = p.start - nowMinutes;
          const diffMs = (diffMin * 60 - nowSeconds) * 1000;
          return { type: 'lock', timeMs: diffMs, dayName: fullDayNames[day], time: p.raw.start };
        }
      }
    }

    if (offset > 0) {
      const firstSlot = parsed[0];
      const daysAhead = offset;
      const minsToMidnight = 1440 - nowMinutes;
      const diffMs = ((minsToMidnight + (daysAhead - 1) * 1440 + firstSlot.start) * 60 - nowSeconds) * 1000;
      return { type: 'lock', timeMs: diffMs, dayName: fullDayNames[day], time: firstSlot.raw.start };
    }
  }
  return null;
}

export interface NextSlotInfo {
  dayIndex: number;
  slot: ScheduleSlot;
}

export function getNextUpcomingSlot(schedule: NoteSchedule): NextSlotInfo | null {
  if (!schedule || !schedule.enabled) return null;
  const now = new Date();
  const nowDay = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (let offset = 0; offset < 7; offset++) {
    const day = (nowDay + offset) % 7;
    const slots = getSlotsForDay(schedule, day);
    if (slots.length === 0) continue;

    const sorted = [...slots].sort((a, b) => {
      const [aH, aM] = a.start.split(':').map(Number);
      const [bH, bM] = b.start.split(':').map(Number);
      return (aH * 60 + aM) - (bH * 60 + bM);
    });

    for (const s of sorted) {
      const [sH, sM] = s.start.split(':').map(Number);
      const startMin = sH * 60 + sM;
      if (offset === 0 && startMin <= nowMinutes) continue;
      return { dayIndex: day, slot: s };
    }

    if (offset > 0) {
      return { dayIndex: day, slot: sorted[0] };
    }
  }
  return null;
}

export async function applySchedules(): Promise<{ updated: boolean; notes: Note[] }> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return api('/notes/apply-schedules', {
    method: 'POST',
    body: JSON.stringify({ timezone }),
  });
}

export function formatScheduleDays(days: number[]): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (days.length === 0) return '';
  if (days.length === 7) return 'Every day';
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'Mon–Fri';
  if (days.length === 2 && [0, 6].every(d => days.includes(d))) return 'Weekends';
  return days.sort((a, b) => a - b).map(d => dayNames[d]).join(', ');
}

export interface ScheduleDayEntry {
  dayIndex: number;
  dayName: string;
  slots: ScheduleSlot[];
}

export function getScheduleByDay(schedule: NoteSchedule): ScheduleDayEntry[] {
  if (!schedule?.enabled) return [];
  const fullDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const result: ScheduleDayEntry[] = [];

  for (const day of dayOrder) {
    if (schedule.perDay) {
      const slots = schedule.perDay[day];
      result.push({ dayIndex: day, dayName: fullDayNames[day], slots: slots && slots.length > 0 ? slots : [] });
    } else if (schedule.days.includes(day)) {
      result.push({ dayIndex: day, dayName: fullDayNames[day], slots: schedule.slots || [] });
    } else {
      result.push({ dayIndex: day, dayName: fullDayNames[day], slots: [] });
    }
  }

  return result;
}

export function getScheduleSummary(schedule: NoteSchedule): string {
  if (!schedule?.enabled) return '';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];

  if (schedule.perDay) {
    const parts: string[] = [];
    for (const day of dayOrder) {
      const slots = schedule.perDay[day];
      if (slots && slots.length > 0) {
        const slotStr = slots.map(s => `${s.start}–${s.end}`).join(', ');
        parts.push(`${dayNames[day]} ${slotStr}`);
      }
    }
    return parts.join(' · ');
  }

  const daysSummary = formatScheduleDays(schedule.days);
  const slotsSummary = schedule.slots
    .map(s => `${s.start}–${s.end}`)
    .join(', ');
  return `${daysSummary} · ${slotsSummary}`;
}
