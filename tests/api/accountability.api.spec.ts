import 'dotenv/config';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { createPgPool, quoteIdent, withSearchPath } from '../helpers/db';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for accountability API tests.');
}

const schemaName = `accountability_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const runId = `e2e-accountability-${Date.now()}`;
const encryptionKey = process.env.ENCRYPTION_KEY || 'timelocknotes-accountability-api-test-key';
const ALWAYS_LOCKED_UNTIL = 253_402_300_800_000;

let adminPool: Pool;
let dbPool: Pool;
let server: Server;
let baseUrl: string;

type PartnerState = 'setup_required' | 'login_required' | 'authenticated' | 'revoked';
type AccessState = 'none' | 'awaiting_setup' | 'active';

interface PartnerNoteDto {
  id: string;
  title: string;
  lockKind: 'timer' | 'always' | 'schedule';
  lockedUntil: number | null;
}

class ApiClient {
  private readonly cookies = new Map<string, string>();
  readonly setCookieHeaders: string[] = [];

  cookie(name: string) {
    return this.cookies.get(name);
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!headers.has('Origin')) headers.set('Origin', baseUrl);

    if (this.cookies.size > 0) {
      headers.set(
        'Cookie',
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      );
    }

    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookie = responseHeaders.getSetCookie?.() ||
      (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);

    for (const value of setCookie) {
      this.setCookieHeaders.push(value);
      const match = /^([^=;]+)=([^;]*)/.exec(value);
      if (!match) continue;
      if (match[2]) this.cookies.set(match[1], match[2]);
      else this.cookies.delete(match[1]);
    }

    return response;
  }

  async json<T>(path: string, init: RequestInit = {}, expectedStatus = 200): Promise<T> {
    const response = await this.request(path, init);
    const text = await response.text();
    expect(response.status, `${init.method || 'GET'} ${path}: ${text}`).toBe(expectedStatus);
    return text ? JSON.parse(text) as T : {} as T;
  }
}

function notePayload(id: string, title: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id,
    title,
    content: '',
    createdAt: now,
    updatedAt: now,
    lockedUntil: null,
    emergencyLength: null,
    hideTypos: false,
    emergencyOpenEnabled: false,
    emergencyOpenPerWeek: 0,
    emergencyOpenLog: [],
    schedule: { enabled: false, days: [], slots: [] },
    deletedAt: null,
    restricted: false,
    ...overrides,
  };
}

function futureMs(minutes = 60) {
  return Date.now() + minutes * 60_000;
}

function currentScheduleWindow() {
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 60_000);
  const end = new Date(now.getTime() + 15 * 60_000);
  const format = (date: Date) =>
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const slots = [{ start: format(start), end: format(end) }];

  return {
    enabled: true,
    days: [now.getDay()],
    slots,
    perDay: { [now.getDay()]: slots },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function saveNote(
  client: ApiClient,
  id: string,
  title: string,
  rawContent: string,
  overrides: Record<string, unknown> = {}
) {
  return client.json<{ success: boolean; note: { lockedUntil: number | null } }>(`/api/notes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      note: notePayload(id, title, overrides),
      rawContent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });
}

async function createInvite(owner = new ApiClient()) {
  const created = await owner.json<{ state: 'awaiting_setup'; token: string }>(
    '/api/accountability/access',
    { method: 'POST' }
  );
  expect(created.state).toBe('awaiting_setup');
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  return { owner, token: created.token };
}

async function bootstrap(client: ApiClient, token: string, expectedState: PartnerState = 'setup_required') {
  const response = await client.json<{ state: PartnerState }>('/api/accountability/bootstrap', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  expect(response).toEqual({ state: expectedState });
  return response;
}

async function claim(client: ApiClient, pin = '012345') {
  const response = await client.json<{ state: PartnerState }>('/api/accountability/claim', {
    method: 'POST',
    body: JSON.stringify({ pin, pinConfirmation: pin }),
  }, 201);
  expect(response).toEqual({ state: 'authenticated' });
  return response;
}

async function establishPartner(pin = '012345') {
  const { owner, token } = await createInvite();
  const partner = new ApiClient();
  await bootstrap(partner, token);
  await claim(partner, pin);
  return { owner, partner, token, pin };
}

async function login(client: ApiClient, token: string, pin: string, expectedStatus = 200) {
  await bootstrap(client, token, 'login_required');
  return client.json<{ state?: PartnerState; error?: string; retryAt?: number }>(
    '/api/accountability/login',
    { method: 'POST', body: JSON.stringify({ pin }) },
    expectedStatus
  );
}

async function partnerNotes(client: ApiClient) {
  return client.json<{ notes: PartnerNoteDto[] }>('/api/accountability/notes');
}

describe('Accountability partner API', () => {
  beforeAll(async () => {
    adminPool = createPgPool(testDatabaseUrl);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);

    const schemaDatabaseUrl = withSearchPath(testDatabaseUrl, schemaName);
    process.env.DATABASE_URL = schemaDatabaseUrl;
    process.env.ENCRYPTION_KEY = encryptionKey;
    process.env.NODE_ENV = 'test';
    dbPool = createPgPool(schemaDatabaseUrl);

    const { default: app } = await import('../../server/app');
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await new ApiClient().json<{ ok: boolean }>('/api/health');
    expect(health.ok).toBe(true);
  });

  beforeEach(async () => {
    await dbPool.query(`
      TRUNCATE TABLE
        accountability_unlock_events,
        accountability_sessions,
        accountability_access,
        notes
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await dbPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
    await adminPool.end();
  });

  test('creates one invitation, atomically claims it, hashes secrets, and preserves a leading-zero PIN', async () => {
    const owner = new ApiClient();
    expect(await owner.json<{ state: AccessState }>('/api/accountability/access')).toEqual({ state: 'none' });

    const { token } = await createInvite(owner);
    await owner.json('/api/accountability/access', { method: 'POST' }, 409);
    const waiting = await owner.json<{ state: AccessState }>('/api/accountability/access');
    expect(waiting).toEqual({ state: 'awaiting_setup' });
    expect(JSON.stringify(waiting)).not.toContain(token);

    const first = new ApiClient();
    const second = new ApiClient();
    await Promise.all([bootstrap(first, token), bootstrap(second, token)]);

    const claims = await Promise.all([
      first.request('/api/accountability/claim', {
        method: 'POST',
        body: JSON.stringify({ pin: '012345', pinConfirmation: '012345' }),
      }),
      second.request('/api/accountability/claim', {
        method: 'POST',
        body: JSON.stringify({ pin: '654321', pinConfirmation: '654321' }),
      }),
    ]);
    expect(claims.filter(response => response.status === 201)).toHaveLength(1);
    expect(claims.filter(response => response.status === 409)).toHaveLength(1);

    const row = (await dbPool.query('SELECT * FROM accountability_access WHERE id = 1')).rows[0];
    expect(row.pin_hash).toEqual(expect.any(String));
    expect(row.pin_hash).toMatch(/scrypt/i);
    expect(row.pin_hash).not.toContain('012345');
    expect(row.pin_hash).not.toContain('654321');
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.invite_token_hash).toBeInstanceOf(Buffer);
    expect(row.invite_token_hash.equals(Buffer.from(token, 'base64url'))).toBe(false);

    const inviteCookie = first.setCookieHeaders.find(value => value.startsWith('accountability_invite='));
    expect(inviteCookie).toMatch(/HttpOnly/i);
    expect(inviteCookie).toMatch(/SameSite=Strict/i);

    const winner = claims[0].status === 201 ? first : second;
    const winningPin = claims[0].status === 201 ? '012345' : '654321';
    const sessionCookie = winner.setCookieHeaders.find(value => value.startsWith('accountability_session='));
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Strict/i);
    expect(sessionCookie).toMatch(/Max-Age=2592000|Expires=/i);

    const storedSession = (await dbPool.query('SELECT token_hash, expires_at FROM accountability_sessions')).rows[0];
    expect(storedSession.token_hash).toBeInstanceOf(Buffer);
    expect(storedSession.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
    expect(storedSession.token_hash.toString('hex')).not.toBe(winner.cookie('accountability_session'));
    expect(storedSession.token_hash.equals(
      Buffer.from(winner.cookie('accountability_session')!, 'base64url')
    )).toBe(false);

    expect(await winner.json<{ state: PartnerState }>('/api/accountability/session')).toEqual({
      state: 'authenticated',
    });
    expect((await owner.json<{ state: AccessState; claimedAt: number }>('/api/accountability/access')).state)
      .toBe('active');

    await winner.json('/api/accountability/logout', { method: 'POST' });
    const relogin = new ApiClient();
    expect(await login(relogin, token, winningPin)).toEqual({ state: 'authenticated' });

    const numericPin = new ApiClient();
    await bootstrap(numericPin, token, 'login_required');
    const invalid = await numericPin.json<{ error: string }>('/api/accountability/login', {
      method: 'POST',
      body: JSON.stringify({ pin: 12345 }),
    }, 400);
    expect(invalid.error).toEqual(expect.any(String));
  });

  test('persists failed logins and enforces a fifteen-minute cooldown after five attempts', async () => {
    const { token } = await establishPartner('012345');
    const attacker = new ApiClient();
    await bootstrap(attacker, token, 'login_required');

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await attacker.json<{ error: string }>('/api/accountability/login', {
        method: 'POST',
        body: JSON.stringify({ pin: '999999' }),
      }, 401);
      expect(response).toEqual({ error: expect.any(String) });
    }

    const fifth = await attacker.request('/api/accountability/login', {
      method: 'POST',
      body: JSON.stringify({ pin: '999999' }),
    });
    expect([401, 429]).toContain(fifth.status);

    const limited = await attacker.json<{ error: string; retryAt: number }>('/api/accountability/login', {
      method: 'POST',
      body: JSON.stringify({ pin: '012345' }),
    }, 429);
    expect(limited.error).toEqual(expect.any(String));
    expect(limited.retryAt).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(limited.retryAt).toBeLessThanOrEqual(Date.now() + 16 * 60_000);

    const row = (await dbPool.query(
      'SELECT failed_attempts, rate_limited_until FROM accountability_access WHERE id = 1'
    )).rows[0];
    expect(row.failed_attempts).toBe(5);
    expect(Number(row.rate_limited_until)).toBe(limited.retryAt);

    await dbPool.query(
      'UPDATE accountability_access SET failed_attempts = 5, rate_limited_until = $1 WHERE id = 1',
      [Date.now() - 1],
    );
    const afterCooldown = await attacker.json<{ error: string }>('/api/accountability/login', {
      method: 'POST',
      body: JSON.stringify({ pin: '999999' }),
    }, 401);
    expect(afterCooldown.error).toBe('invalid_credentials');
    const resetRow = (await dbPool.query(
      'SELECT failed_attempts, rate_limited_until FROM accountability_access WHERE id = 1'
    )).rows[0];
    expect(resetRow.failed_attempts).toBe(1);
    expect(resetRow.rate_limited_until).toBeNull();
  });

  test('changes the PIN, keeps the current session, and invalidates every other session', async () => {
    const { partner: primary, token } = await establishPartner('012345');
    const secondary = new ApiClient();
    expect(await login(secondary, token, '012345')).toEqual({ state: 'authenticated' });
    expect((await dbPool.query('SELECT 1 FROM accountability_sessions')).rowCount).toBe(2);

    const changed = await primary.json<{ state: PartnerState }>('/api/accountability/pin', {
      method: 'POST',
      body: JSON.stringify({
        currentPin: '012345',
        newPin: '001234',
        newPinConfirmation: '001234',
      }),
    });
    expect(changed).toEqual({ state: 'authenticated' });

    expect(await primary.json<{ state: PartnerState }>('/api/accountability/session')).toEqual({
      state: 'authenticated',
    });
    expect(await secondary.json<{ state: PartnerState }>('/api/accountability/session')).toEqual({
      state: 'login_required',
    });
    expect((await dbPool.query('SELECT 1 FROM accountability_sessions')).rowCount).toBe(1);

    await primary.json('/api/accountability/logout', { method: 'POST' });
    const oldPin = new ApiClient();
    await bootstrap(oldPin, token, 'login_required');
    await oldPin.json<{ error: string }>('/api/accountability/login', {
      method: 'POST',
      body: JSON.stringify({ pin: '012345' }),
    }, 401);

    const newPin = new ApiClient();
    expect(await login(newPin, token, '001234')).toEqual({ state: 'authenticated' });
  });

  test('expires persisted sessions and denies note metadata without authentication', async () => {
    const unauthenticated = new ApiClient();
    await unauthenticated.json<{ error: string }>('/api/accountability/notes', {}, 401);

    const { partner } = await establishPartner();
    await dbPool.query('UPDATE accountability_sessions SET expires_at = $1', [Date.now() - 1]);

    expect(await partner.json<{ state: PartnerState }>('/api/accountability/session')).toEqual({
      state: 'login_required',
    });
    await partner.json<{ error: string }>('/api/accountability/notes', {}, 401);
  });

  test('requires the existing PIN when reopening the original link and blocks unauthenticated replacement', async () => {
    const { owner, partner, token, pin } = await establishPartner();
    await owner.json('/api/accountability/access', { method: 'POST' }, 409);
    await owner.json('/api/accountability/access/replace', { method: 'POST' }, 403);
    expect((await owner.request('/api/accountability/access', { method: 'DELETE' })).status).toBe(404);
    expect(await owner.json('/api/accountability/access')).toEqual({ state: 'active', claimedAt: expect.any(Number) });

    await bootstrap(owner, token, 'login_required');
    await owner.json('/api/accountability/notes', {}, 401);
    await owner.json('/api/accountability/claim', {
      method: 'POST',
      body: JSON.stringify({ pin: '111111', pinConfirmation: '111111' }),
    }, 409);
    await partner.json('/api/accountability/notes');

    await bootstrap(partner, token, 'login_required');
    await partner.json('/api/accountability/notes', {}, 401);
    expect((await dbPool.query('SELECT 1 FROM accountability_sessions')).rowCount).toBe(0);
    expect(await login(partner, token, pin)).toEqual({ state: 'authenticated' });
  });

  test('replaces the single invitation and revokes active sessions only with the management key', async () => {
    const previousKey = process.env.PARTNER_MANAGEMENT_KEY;
    const managementKey = 'test-only-partner-management-key-32-characters';
    process.env.PARTNER_MANAGEMENT_KEY = managementKey;
    try {
      const { owner, partner, token } = await establishPartner();
      const path = '/api/accountability/access/replace';
      const request = { method: 'POST', body: JSON.stringify({ managementKey }) };
      await owner.json(path, { ...request, headers: { Origin: 'https://example.com' } }, 403);
      await owner.json(path, { ...request, body: JSON.stringify({ managementKey: 'wrong' }) }, 403);
      await partner.json('/api/accountability/notes');
      const replacement = await owner.json<{ state: AccessState; token: string }>(path, request);
      expect(replacement.state).toBe('awaiting_setup');
      expect(replacement.token).not.toBe(token);
      await partner.json('/api/accountability/notes', {}, 401);
      await bootstrap(new ApiClient(), token, 'revoked');
      const newPartner = new ApiClient();
      await bootstrap(newPartner, replacement.token);
      await claim(newPartner);
      await owner.json('/api/accountability/access', { method: 'POST' }, 409);
    } finally {
      if (previousKey === undefined) delete process.env.PARTNER_MANAGEMENT_KEY;
      else process.env.PARTNER_MANAGEMENT_KEY = previousKey;
    }
  });

  test('returns only minimal metadata for live locked notes and blocks locked content and lock shortening', async () => {
    const owner = new ApiClient();
    const { partner } = await establishPartner();
    const timerId = `${runId}-timer`;
    const alwaysId = `${runId}-always`;
    const scheduleId = `${runId}-schedule-list`;
    const unlockedId = `${runId}-unlocked`;
    const deletedId = `${runId}-deleted`;
    const timerLock = futureMs(90);

    await saveNote(owner, timerId, 'Private timer body', 'Private timer content', {
      lockedUntil: timerLock,
      restricted: true,
    });
    await saveNote(owner, alwaysId, 'Private always title', 'Private always content', {
      lockedUntil: ALWAYS_LOCKED_UNTIL,
      restricted: true,
    });
    await saveNote(owner, scheduleId, 'Private schedule title', 'Private schedule content', {
      schedule: currentScheduleWindow(),
      restricted: true,
    });
    await saveNote(owner, unlockedId, 'Unlocked title', 'Unlocked content');
    await saveNote(owner, deletedId, 'Deleted title', 'Deleted content', {
      lockedUntil: futureMs(),
      deletedAt: Date.now(),
    });

    const contentResponse = await owner.request(`/api/notes/${timerId}/content`);
    expect(contentResponse.status).toBe(423);
    expect(await contentResponse.json()).toEqual({ error: expect.any(String) });

    await owner.request(`/api/notes/${timerId}/set-lock-until`, {
      method: 'POST',
      body: JSON.stringify({ timestamp: Date.now() - 1 }),
    });
    await saveNote(owner, timerId, 'Attempted overwrite', 'Attempted overwrite', {
      lockedUntil: null,
      restricted: true,
    });
    const persisted = (await dbPool.query(
      'SELECT title, locked_until FROM notes WHERE id = $1',
      [timerId]
    )).rows[0];
    expect(persisted.title).toBe('Private timer body');
    expect(Number(persisted.locked_until)).toBe(timerLock);

    const response = await partner.request('/api/accountability/notes');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json() as { notes: PartnerNoteDto[] };
    expect(body.notes.map(note => note.id).sort()).toEqual([alwaysId, scheduleId, timerId].sort());

    for (const note of body.notes) {
      expect(Object.keys(note).sort()).toEqual(['id', 'lockKind', 'lockedUntil', 'title']);
      expect(JSON.stringify(note)).not.toMatch(/content|thumbnail|emergency|gibberish/i);
    }
    expect(body.notes.find(note => note.id === timerId)).toEqual({
      id: timerId,
      title: 'Private timer body',
      lockKind: 'timer',
      lockedUntil: timerLock,
    });
    expect(body.notes.find(note => note.id === alwaysId)?.lockKind).toBe('always');
    expect(body.notes.find(note => note.id === scheduleId)?.lockKind).toBe('schedule');
  });

  test('unlocks timed and always-locked notes once, records one audit event, and is concurrency safe', async () => {
    const owner = new ApiClient();
    const { partner } = await establishPartner();
    const timerId = `${runId}-concurrent-timer`;
    const alwaysId = `${runId}-unlock-always`;
    await saveNote(owner, timerId, 'Concurrent timer', 'Timer secret', {
      lockedUntil: futureMs(),
      restricted: true,
    });
    await saveNote(owner, alwaysId, 'Always timer', 'Always secret', {
      lockedUntil: ALWAYS_LOCKED_UNTIL,
      restricted: true,
    });

    const staleTimerState = (await dbPool.query(
      'SELECT updated_at, locked_until FROM notes WHERE id = $1',
      [timerId],
    )).rows[0];

    const responses = await Promise.all([
      partner.json<{ success: true; result: string }>(`/api/accountability/notes/${timerId}/unlock`, {
        method: 'POST',
      }),
      partner.json<{ success: true; result: string }>(`/api/accountability/notes/${timerId}/unlock`, {
        method: 'POST',
      }),
    ]);
    expect(responses.map(response => response.result).sort()).toEqual(['already_unlocked', 'unlocked']);

    await saveNote(owner, timerId, 'Stale timer save', 'Stale body', {
      updatedAt: Number(staleTimerState.updated_at),
      lockedUntil: Number(staleTimerState.locked_until),
      restricted: true,
    });
    expect((await dbPool.query('SELECT locked_until FROM notes WHERE id = $1', [timerId])).rows[0].locked_until)
      .toBeNull();

    await saveNote(owner, timerId, 'Second stale timer save', 'Second stale body', {
      updatedAt: Number(staleTimerState.updated_at),
      lockedUntil: Number(staleTimerState.locked_until),
      restricted: true,
    });
    expect((await dbPool.query('SELECT locked_until FROM notes WHERE id = $1', [timerId])).rows[0].locked_until)
      .toBeNull();

    expect(await partner.json(`/api/accountability/notes/${timerId}/unlock`, { method: 'POST' }))
      .toEqual({ success: true, result: 'already_unlocked' });
    expect(await partner.json(`/api/accountability/notes/${alwaysId}/unlock`, { method: 'POST' }))
      .toEqual({ success: true, result: 'unlocked' });

    const notes = await dbPool.query(
      'SELECT id, locked_until FROM notes WHERE id = ANY($1::text[]) ORDER BY id',
      [[timerId, alwaysId]]
    );
    expect(notes.rows.every(row => row.locked_until === null)).toBe(true);

    const audit = await dbPool.query(
      'SELECT note_id, lock_kind, previous_locked_until FROM accountability_unlock_events ORDER BY note_id',
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.map(row => row.note_id).sort()).toEqual([alwaysId, timerId].sort());
    expect(audit.rows.find(row => row.note_id === timerId)?.lock_kind).toBe('timer');
    expect(audit.rows.find(row => row.note_id === alwaysId)?.lock_kind).toBe('always');

    expect(await owner.json<{ content: string }>(`/api/notes/${timerId}/content`)).toEqual({
      content: 'Timer secret',
    });

    const observedVersion = (await dbPool.query(
      'SELECT updated_at FROM notes WHERE id = $1',
      [timerId],
    )).rows[0].updated_at;
    await saveNote(owner, timerId, 'Deliberately relocked timer', 'Fresh body', {
      updatedAt: Number(observedVersion),
      lockedUntil: futureMs(30),
      restricted: true,
    });
    await owner.json(`/api/notes/${timerId}/content`, {}, 423);
    expect(await partner.json(`/api/accountability/notes/${timerId}/unlock`, { method: 'POST' }))
      .toEqual({ success: true, result: 'unlocked' });
    expect(await owner.json<{ content: string }>(`/api/notes/${timerId}/content`)).toEqual({
      content: 'Fresh body',
    });

    const missing = await partner.json<{ error: string }>(
      `/api/accountability/notes/${runId}-missing/unlock`,
      { method: 'POST' },
      404
    );
    expect(missing).toEqual({ error: 'not_found' });
  });

  test('unlocks only the active schedule window and preserves the recurring schedule', async () => {
    const owner = new ApiClient();
    const { partner } = await establishPartner();
    const scheduleId = `${runId}-schedule-unlock`;
    const schedule = currentScheduleWindow();
    const saved = await saveNote(owner, scheduleId, 'Scheduled note', 'Scheduled secret', {
      schedule,
      restricted: true,
    });
    expect(saved.note.lockedUntil).toEqual(expect.any(Number));
    const activeWindowEnd = saved.note.lockedUntil!;

    expect(await partner.json(`/api/accountability/notes/${scheduleId}/unlock`, { method: 'POST' }))
      .toEqual({ success: true, result: 'unlocked' });

    const stored = (await dbPool.query(
      'SELECT locked_until, schedule_override_until, schedule FROM notes WHERE id = $1',
      [scheduleId]
    )).rows[0];
    expect(stored.locked_until).toBeNull();
    expect(Number(stored.schedule_override_until)).toBeGreaterThanOrEqual(activeWindowEnd - 1_000);
    expect(Number(stored.schedule_override_until)).toBeLessThanOrEqual(activeWindowEnd + 60_000);
    expect(stored.schedule.enabled).toBe(true);

    const applied = await owner.json<{ notes: Array<{ id: string; lockedUntil: number | null }> }>(
      '/api/notes/apply-schedules',
      {
        method: 'POST',
        body: JSON.stringify({ timezone: schedule.timezone }),
      }
    );
    expect(applied.notes.find(note => note.id === scheduleId)?.lockedUntil).toBeNull();
    expect((await partnerNotes(partner)).notes.some(note => note.id === scheduleId)).toBe(false);

    const audit = (await dbPool.query(
      'SELECT lock_kind, previous_locked_until FROM accountability_unlock_events WHERE note_id = $1',
      [scheduleId]
    )).rows[0];
    expect(audit.lock_kind).toBe('schedule');
    expect(Number(audit.previous_locked_until)).toBe(activeWindowEnd);
  });

  test('rejects cross-origin partner mutations and applies private response headers', async () => {
    const { partner } = await establishPartner();
    const ownerMutation = await partner.request('/api/accountability/access', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(ownerMutation.status).toBe(403);

    const response = await partner.request('/api/accountability/logout', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');

    expect(await partner.json<{ state: PartnerState }>('/api/accountability/session')).toEqual({
      state: 'authenticated',
    });
  });
});
