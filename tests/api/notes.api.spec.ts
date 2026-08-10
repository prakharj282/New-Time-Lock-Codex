import 'dotenv/config';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import {
  cleanupE2eNotes,
  createPgPool,
  E2E_TITLE_PREFIX,
  quoteIdent,
  withSearchPath,
} from '../helpers/db';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for API tests.');
}

const runId = `e2e-api-${Date.now()}`;
const schemaName = `api_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const encryptionKey = process.env.ENCRYPTION_KEY || 'timelocknotes-api-test-key';

let adminPool: Pool;
let dbPool: Pool;
let server: Server;
let baseUrl: string;

function futureMs(minutes = 60) {
  return Date.now() + minutes * 60_000;
}

function currentScheduleWindow() {
  const now = new Date();
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + 10 * 60_000);
  const fmt = (date: Date) =>
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  return {
    day: now.getDay(),
    schedule: {
      enabled: true,
      days: [now.getDay()],
      slots: [{ start: fmt(start), end: fmt(end) }],
      perDay: {
        [now.getDay()]: [{ start: fmt(start), end: fmt(end) }],
      },
    },
  };
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

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await api(path, init);
  const body = await response.text();
  expect(response.status, `${path} returned ${response.status}`).not.toBe(404);
  expect(response.ok, `${path} returned ${response.status}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function saveNote(id: string, title: string, rawContent: string, overrides: Record<string, unknown> = {}) {
  return apiJson<{ success: boolean; note: { id: string; title: string; content: string; lockedUntil: number | null } }>(
    `/api/notes/${id}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        note: notePayload(id, title, overrides),
        rawContent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    }
  );
}

describe('Express notes API', () => {
  beforeAll(async () => {
    adminPool = createPgPool(testDatabaseUrl);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);
    await adminPool.query(
      `CREATE TABLE ${quoteIdent(schemaName)}.notes (id bigint primary key generated always as identity, title text not null)`
    );
    await adminPool.query(`INSERT INTO ${quoteIdent(schemaName)}.notes (title) VALUES ('Supabase sample row')`);

    const schemaDatabaseUrl = withSearchPath(testDatabaseUrl, schemaName);
    process.env.DATABASE_URL = schemaDatabaseUrl;
    process.env.ENCRYPTION_KEY = encryptionKey;
    dbPool = createPgPool(schemaDatabaseUrl);

    const { default: app } = await import('../../server/app');
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await dbPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
    await adminPool.end();
  });

  test('health initializes schema and migrates incompatible Supabase starter table', async () => {
    const health = await apiJson<{ ok: boolean; database: string }>('/api/health');
    expect(health).toEqual({ ok: true, database: 'connected' });

    const idColumn = await dbPool.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'notes' AND column_name = 'id'
    `);
    expect(idColumn.rows[0].data_type).toBe('text');

    const backups = await dbPool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'notes_supabase_sample_backup_%'
    `);
    expect(backups.rowCount).toBe(1);
    await cleanupE2eNotes(dbPool);
  });

  test('health reports missing env clearly before doing real API work', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const response = await api('/api/health');
    process.env.DATABASE_URL = originalDatabaseUrl;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, missingEnv: ['DATABASE_URL'] });
  });

  test('creates notes encrypted at rest and list API never exposes body content', async () => {
    const id = `${runId}-encrypted`;
    const title = `${E2E_TITLE_PREFIX} ${runId} encrypted`;
    const rawContent = 'api encrypted body with password-like text';

    const saved = await saveNote(id, title, rawContent);
    expect(saved.success).toBe(true);
    expect(saved.note.content).toBe('');

    const notes = await apiJson<Array<{ id: string; title: string; content: string }>>('/api/notes');
    const listed = notes.find(note => note.id === id);
    expect(listed).toMatchObject({ id, title, content: '' });

    const stored = await dbPool.query('SELECT content FROM notes WHERE id = $1', [id]);
    expect(stored.rows[0].content).not.toBe(rawContent);
    expect(stored.rows[0].content).toContain(':');

    const content = await apiJson<{ content: string }>(`/api/notes/${id}/content`);
    expect(content.content).toBe(rawContent);
  });

  test('edits unlocked notes and deletes notes', async () => {
    const id = `${runId}-edit-delete`;
    await saveNote(id, `${E2E_TITLE_PREFIX} ${runId} edit`, 'first body');
    await saveNote(id, `${E2E_TITLE_PREFIX} ${runId} edited`, 'edited body');

    expect(await apiJson<{ content: string }>(`/api/notes/${id}/content`)).toEqual({ content: 'edited body' });

    const deleted = await apiJson<{ success: boolean }>(`/api/notes/${id}`, { method: 'DELETE' });
    expect(deleted.success).toBe(true);

    const notes = await apiJson<Array<{ id: string }>>('/api/notes');
    expect(notes.some(note => note.id === id)).toBe(false);
  });

  test('preserves locked note content and allows title changes through title endpoint', async () => {
    const id = `${runId}-locked-preserve`;
    const originalTitle = `${E2E_TITLE_PREFIX} ${runId} locked`;
    await saveNote(id, originalTitle, 'locked body', {
      lockedUntil: futureMs(),
      emergencyLength: 20,
      restricted: true,
    });

    await saveNote(id, `${E2E_TITLE_PREFIX} ${runId} bad overwrite`, 'bad overwritten body', {
      lockedUntil: futureMs(),
      emergencyLength: 20,
      restricted: true,
    });

    const blockedContent = await api(`/api/notes/${id}/content`);
    expect(blockedContent.status).toBe(423);
    expect(await blockedContent.json()).toEqual({ error: expect.any(String) });

    const encryptedBeforeTitleChange = await dbPool.query('SELECT content FROM notes WHERE id = $1', [id]);
    const notesAfterBlockedSave = await apiJson<Array<{ id: string; title: string }>>('/api/notes');
    expect(notesAfterBlockedSave.find(note => note.id === id)?.title).toBe(originalTitle);

    const titleResult = await apiJson<{ success: boolean; note: { title: string } }>(`/api/notes/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title: `${E2E_TITLE_PREFIX} ${runId} locked title changed` }),
    });
    expect(titleResult.note.title).toContain('title changed');
    const encryptedAfterTitleChange = await dbPool.query('SELECT content FROM notes WHERE id = $1', [id]);
    expect(encryptedAfterTitleChange.rows[0].content).toBe(encryptedBeforeTitleChange.rows[0].content);

    expect(await apiJson<{ success: boolean }>(`/api/notes/${id}/emergency-unlock`, { method: 'POST' }))
      .toMatchObject({ success: true });
    expect(await apiJson<{ content: string }>(`/api/notes/${id}/content`)).toEqual({ content: 'locked body' });
  });

  test('emergency unlock and emergency open quota work server-side', async () => {
    const unlockId = `${runId}-emergency-unlock`;
    await saveNote(unlockId, `${E2E_TITLE_PREFIX} ${runId} emergency unlock`, 'unlock body', {
      lockedUntil: futureMs(),
      emergencyLength: 20,
      restricted: true,
    });
    expect(await apiJson<{ success: boolean }>(`/api/notes/${unlockId}/emergency-unlock`, { method: 'POST' })).toMatchObject({
      success: true,
    });

    const openId = `${runId}-emergency-open`;
    await saveNote(openId, `${E2E_TITLE_PREFIX} ${runId} emergency open`, 'open body', {
      lockedUntil: futureMs(),
      emergencyLength: 20,
      emergencyOpenEnabled: true,
      emergencyOpenPerWeek: 1,
      emergencyOpenLog: [],
      restricted: true,
    });

    expect(await apiJson<{ success: boolean; usedThisWeek: number }>(`/api/notes/${openId}/emergency-open`, { method: 'POST' })).toMatchObject({
      success: true,
      usedThisWeek: 1,
    });
    expect(await apiJson<{ success: boolean; lockedUntil: number }>(`/api/notes/${openId}/set-lock-until`, {
      method: 'POST',
      body: JSON.stringify({ timestamp: futureMs() }),
    })).toMatchObject({ success: true });
    expect(await apiJson<{ success: boolean; error: string }>(`/api/notes/${openId}/emergency-open`, { method: 'POST' })).toMatchObject({
      success: false,
      error: 'quota_exhausted',
    });
  });

  test('schedule locks, photo content, and app time state persist', async () => {
    const scheduleId = `${runId}-schedule`;
    const { schedule } = currentScheduleWindow();
    const scheduleResult = await saveNote(scheduleId, `${E2E_TITLE_PREFIX} ${runId} schedule`, 'schedule body', {
      schedule,
      emergencyLength: 20,
      restricted: true,
    });
    expect(scheduleResult.note.lockedUntil).toEqual(expect.any(Number));

    const apply = await apiJson<{ updated: boolean; notes: Array<{ id: string }> }>('/api/notes/apply-schedules', {
      method: 'POST',
      body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    expect(apply.notes.some(note => note.id === scheduleId)).toBe(true);

    const photoId = `${runId}-photo`;
    const imageJson = JSON.stringify({ type: 'image', data: 'data:image/png;base64,abc123' });
    await saveNote(photoId, `${E2E_TITLE_PREFIX} ${runId} photo`, imageJson);
    expect(await apiJson<{ content: string }>(`/api/notes/${photoId}/content`)).toEqual({ content: imageJson });

    expect(await apiJson<{ success: boolean }>('/api/time/save', { method: 'POST' })).toEqual({ success: true });
    expect((await apiJson<{ time: number }>('/api/time/last-known')).time).toBeGreaterThan(0);
  });
});
