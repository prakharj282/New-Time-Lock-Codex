import 'dotenv/config';
import express from 'express';
import { Pool, type PoolClient } from 'pg';
import crypto from 'crypto';
import { createAccountabilityRouter } from './accountability';

const app = express();
app.use(express.json({ limit: '10mb' }));

type EnvName = 'DATABASE_URL' | 'ENCRYPTION_KEY';

function missingEnvVars(): EnvName[] {
  return (['DATABASE_URL', 'ENCRYPTION_KEY'] as EnvName[]).filter(name => !process.env[name]);
}

function requireEnv(name: EnvName): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = requireEnv('DATABASE_URL');
    let poolConnectionString = connectionString;
    const needsSsl = /sslmode=require|supabase\.com|pooler\.supabase\.com/i.test(connectionString);

    if (needsSsl) {
      try {
        const parsed = new URL(connectionString);
        parsed.searchParams.delete('sslmode');
        poolConnectionString = parsed.toString();
      } catch {
        poolConnectionString = connectionString.replace(/([?&])sslmode=[^&]+&?/i, '$1');
      }
    }

    pool = new Pool({
      connectionString: poolConnectionString,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 30,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

function getEncryptionKey(): string {
  return requireEnv('ENCRYPTION_KEY');
}

export default app;

function deriveKey(passphrase: string): Buffer {
  return crypto.scryptSync(passphrase, 'timelocknotes-salt', 32);
}

function encrypt(text: string): string {
  const key = deriveKey(getEncryptionKey());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${encrypted}:${tag.toString('base64')}`;
}

function decrypt(encryptedText: string): string {
  if (!encryptedText || !encryptedText.includes(':')) return encryptedText;
  const key = deriveKey(getEncryptionKey());
  try {
    const parts = encryptedText.split(':');
    if (parts.length < 3) return encryptedText;
    const [ivB64, cipherB64, tagB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(cipherB64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '';
  }
}

interface DbNote {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  locked_until: string | null;
  emergency_length: number | null;
  hide_typos: boolean;
  emergency_open_enabled: boolean;
  emergency_open_per_week: number;
  emergency_open_log: number[];
  schedule: NoteSchedule | null;
  schedule_override_until: string | null;
  deleted_at: string | null;
  restricted: boolean;
}

interface ScheduleSlot {
  start: string;
  end: string;
}

interface NoteSchedule {
  enabled: boolean;
  days?: number[];
  slots?: ScheduleSlot[];
  perDay?: Record<number, ScheduleSlot[]>;
  timezone?: string;
}

function dbToNote(row: DbNote) {
  return {
    id: row.id,
    title: row.title,
    content: '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lockedUntil: row.locked_until ? Number(row.locked_until) : null,
    emergencyLength: row.emergency_length,
    hideTypos: row.hide_typos,
    emergencyOpenEnabled: row.emergency_open_enabled,
    emergencyOpenPerWeek: row.emergency_open_per_week,
    emergencyOpenLog: row.emergency_open_log || [],
    schedule: row.schedule || { enabled: false, days: [], slots: [] },
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
    restricted: row.restricted || false,
  };
}

async function runDatabaseMigrations(client: PoolClient) {
  const schemaResult = await client.query('SELECT current_schema() AS schema');
  const activeSchema = schemaResult.rows[0]?.schema || 'public';
  const existingIdColumn = await client.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'notes' AND column_name = 'id'
  `, [activeSchema]);

  if (existingIdColumn.rows.length > 0 && existingIdColumn.rows[0].data_type !== 'text') {
    const backupName = `notes_supabase_sample_backup_${Date.now()}`;
    await client.query(`ALTER TABLE notes RENAME TO "${backupName}"`);
    console.warn(`Existing incompatible notes table was renamed to ${backupName}`);
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Note',
      content TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      locked_until BIGINT,
      emergency_length INTEGER,
      hide_typos BOOLEAN NOT NULL DEFAULT FALSE,
      emergency_open_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      emergency_open_per_week INTEGER NOT NULL DEFAULT 0,
      emergency_open_log JSONB NOT NULL DEFAULT '[]'::JSONB,
      schedule JSONB NOT NULL DEFAULT '{"enabled": false, "days": [], "slots": []}'::JSONB,
      schedule_override_until BIGINT,
      deleted_at BIGINT,
      restricted BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'New Note'`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT ''`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked_until BIGINT`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS emergency_length INTEGER`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS hide_typos BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS emergency_open_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS emergency_open_per_week INTEGER NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS emergency_open_log JSONB NOT NULL DEFAULT '[]'::JSONB`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS schedule JSONB NOT NULL DEFAULT '{"enabled": false, "days": [], "slots": []}'::JSONB`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS schedule_override_until BIGINT`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at BIGINT`);
  await client.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS accountability_access (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      invite_token_hash BYTEA NOT NULL,
      pin_hash TEXT,
      claimed_at BIGINT,
      failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      rate_limited_until BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS accountability_sessions (
      token_hash BYTEA PRIMARY KEY,
      access_id SMALLINT NOT NULL REFERENCES accountability_access(id) ON DELETE CASCADE,
      created_at DOUBLE PRECISION NOT NULL,
      expires_at DOUBLE PRECISION NOT NULL
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS accountability_sessions_expires_at_idx
    ON accountability_sessions (expires_at);
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS accountability_unlock_events (
      id BIGSERIAL PRIMARY KEY,
      note_id TEXT NOT NULL,
      access_id SMALLINT NOT NULL,
      unlocked_at BIGINT NOT NULL,
      lock_kind TEXT NOT NULL CHECK (lock_kind IN ('timer', 'always', 'schedule')),
      previous_locked_until BIGINT NOT NULL,
      schedule_override_until BIGINT
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS accountability_unlock_events_note_time_idx
    ON accountability_unlock_events (note_id, unlocked_at DESC);
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const requiredColumn = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name = 'notes'
       AND column_name = 'schedule_override_until'`,
    [activeSchema],
  );
  if (requiredColumn.rows.length !== 1) {
    throw new Error('Database schema initialization did not create all required columns.');
  }
}

async function initDatabase() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('timelock_notes_schema_v2'))");
    await runDatabaseMigrations(client);
    await client.query('COMMIT');
    console.log('Database schema initialized');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let databaseInitPromise: Promise<void> | null = null;

export function ensureDatabaseInitialized(): Promise<void> {
  if (!databaseInitPromise) {
    databaseInitPromise = initDatabase().catch((err) => {
      databaseInitPromise = null;
      throw err;
    });
  }
  return databaseInitPromise;
}

app.get('/api/health', async (_req, res) => {
  const missing = missingEnvVars();
  if (missing.length > 0) {
    return res.status(503).json({ ok: false, missingEnv: missing });
  }

  try {
    await ensureDatabaseInitialized();
    await getPool().query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    console.error('GET /api/health error:', err);
    res.status(503).json({ ok: false, error: 'Database connection failed' });
  }
});

app.use('/api', async (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }

  const missing = missingEnvVars();
  if (missing.length > 0) {
    return res.status(503).json({ error: 'Missing server configuration', missingEnv: missing });
  }

  try {
    await ensureDatabaseInitialized();
    next();
  } catch (err) {
    console.error('API initialization error:', err);
    res.status(500).json({ error: 'Server initialization failed' });
  }
});

app.use('/api/accountability', createAccountabilityRouter({
  getPool,
  getEncryptionKey,
  getActiveSlotEnd,
}));

app.get('/api/notes', async (_req, res) => {
  try {
    const result = await getPool().query(
      'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC'
    );
    const notes = result.rows.map(dbToNote);
    res.json(notes);
  } catch (err) {
    console.error('GET /api/notes error:', err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

app.get('/api/notes/:id/content', async (req, res) => {
  try {
    const result = await getPool().query(
      'SELECT content, locked_until FROM notes WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.json({ content: '' });
    if (result.rows[0].locked_until && Number(result.rows[0].locked_until) > Date.now()) {
      return res.status(423).json({ error: 'locked' });
    }
    const decrypted = decrypt(result.rows[0].content || '');
    res.json({ content: decrypted });
  } catch (err) {
    console.error('GET /api/notes/:id/content error:', err);
    res.status(500).json({ error: 'Failed to get note content' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  const client = await getPool().connect();
  try {
    const { note, rawContent } = req.body;
    if (!note || typeof note !== 'object') {
      return res.status(400).json({ error: 'Note is required' });
    }
    const id = req.params.id;
    const encryptedContent = encrypt(rawContent || '');

    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT n.restricted, n.content, n.title, n.locked_until, n.schedule,
              n.schedule_override_until, n.updated_at
       FROM notes n WHERE n.id = $1 FOR UPDATE`,
      [id]
    );
    const existingRow = existing.rows.length > 0 ? existing.rows[0] : null;
    const now = Math.max(Date.now(), Number(existingRow?.updated_at || 0) + 1);
    const existingRestricted = existingRow ? existingRow.restricted : false;
    const existingLocked = !!existingRow?.locked_until && Number(existingRow.locked_until) > now;
    const clientUpdatedAt = Number(note.updatedAt || 0);
    const scheduleOverrideActive = !!existingRow?.schedule_override_until
      && Number(existingRow.schedule_override_until) > now;
    const staleNote = !!existingRow && Number(existingRow.updated_at) > clientUpdatedAt;
    const legacySchedule: NoteSchedule | undefined = existingRow?.schedule?.enabled && !existingRow.schedule.timezone
      ? existingRow.schedule
      : undefined;
    // A SELECT that waited for the row lock may have a snapshot older than the unlock event.
    const lastPartnerUnlock = staleNote || legacySchedule ? await getLastPartnerUnlock(client, id) : null;
    const partnerUnlockIsNewer = lastPartnerUnlock !== null && lastPartnerUnlock > clientUpdatedAt;
    const preservePartnerUnlock = staleNote && (partnerUnlockIsNewer || scheduleOverrideActive);
    const preserveServerData = existingLocked || preservePartnerUnlock;
    const finalRestricted = existingRestricted || (note.restricted || false);
    const finalContent = preserveServerData ? existingRow.content : encryptedContent;
    const finalTitle = preserveServerData ? existingRow.title : (note.title || 'New Note');

    let lockedUntil = preservePartnerUnlock
      ? (existingRow.locked_until ? Number(existingRow.locked_until) : null)
      : (note.lockedUntil || null);
    if (existingLocked) {
      const currentLockedUntil = Number(existingRow.locked_until);
      if (!lockedUntil || Number(lockedUntil) < currentLockedUntil) {
        lockedUntil = currentLockedUntil;
      }
    }
    const requestedSchedule = preservePartnerUnlock
      ? (existingRow.schedule || { enabled: false, days: [], slots: [] })
      : (note.schedule || { enabled: false, days: [], slots: [] });
    const schedule = withScheduleTimezone(requestedSchedule, existingRow?.schedule?.timezone || req.body.timezone);
    let recoveredOverride: number | null = null;
    if (!lockedUntil && !scheduleOverrideActive) {
      const slotEnd = getActiveSlotEnd(schedule)?.getTime();
      if (slotEnd && legacySchedule && lastPartnerUnlock !== null
        && getActiveSlotEnd(legacySchedule, schedule.timezone, lastPartnerUnlock)?.getTime() === slotEnd) {
        recoveredOverride = slotEnd;
      } else if (slotEnd) {
        lockedUntil = slotEnd;
      }
    }

    const result = await client.query(
      `INSERT INTO notes (id, title, content, created_at, updated_at, locked_until, emergency_length, hide_typos, emergency_open_enabled, emergency_open_per_week, emergency_open_log, schedule, deleted_at, restricted, schedule_override_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         content = EXCLUDED.content,
         updated_at = EXCLUDED.updated_at,
         locked_until = EXCLUDED.locked_until,
         emergency_length = EXCLUDED.emergency_length,
         hide_typos = EXCLUDED.hide_typos,
         emergency_open_enabled = EXCLUDED.emergency_open_enabled,
         emergency_open_per_week = EXCLUDED.emergency_open_per_week,
         emergency_open_log = EXCLUDED.emergency_open_log,
         schedule = EXCLUDED.schedule,
         schedule_override_until = COALESCE(EXCLUDED.schedule_override_until, notes.schedule_override_until),
         deleted_at = EXCLUDED.deleted_at,
         restricted = EXCLUDED.restricted
       RETURNING *`,
      [
        id,
        finalTitle,
        finalContent,
        note.createdAt || now,
        now,
        lockedUntil,
        note.emergencyLength || null,
        note.hideTypos || false,
        note.emergencyOpenEnabled || false,
        note.emergencyOpenPerWeek || 0,
        JSON.stringify(note.emergencyOpenLog || []),
        JSON.stringify(schedule),
        note.deletedAt || null,
        finalRestricted,
        recoveredOverride,
      ]
    );
    await client.query('COMMIT');
    res.json({ success: true, note: dbToNote(result.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('PUT /api/notes/:id error:', err);
    res.status(500).json({ error: 'Failed to save note' });
  } finally {
    client.release();
  }
});

app.patch('/api/notes/:id/title', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required' });
    }
    const result = await getPool().query(
      'UPDATE notes SET title = $1, updated_at = GREATEST($2, updated_at + 1) WHERE id = $3 RETURNING *',
      [title, Date.now(), req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json({ success: true, note: dbToNote(result.rows[0]) });
  } catch (err) {
    console.error('PATCH /api/notes/:id/title error:', err);
    res.status(500).json({ error: 'Failed to update title' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    await getPool().query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/notes/:id error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

app.post('/api/notes/:id/extend-lock', async (req, res) => {
  try {
    const { additionalMs } = req.body;
    if (!Number.isSafeInteger(additionalMs) || additionalMs <= 0) {
      return res.status(400).json({ error: 'Invalid lock extension' });
    }
    const requestStartedAt = Date.now();
    const result = await getPool().query(
      `UPDATE notes
       SET locked_until = locked_until + $1,
           updated_at = GREATEST($2, updated_at + 1)
       WHERE id = $3
         AND locked_until IS NOT NULL
         AND locked_until > $2
         AND NOT EXISTS (
           SELECT 1 FROM accountability_unlock_events event
           WHERE event.note_id = notes.id AND event.unlocked_at >= $2
         )
       RETURNING locked_until`,
      [additionalMs, requestStartedAt, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false });
    }
    const newLockedUntil = Number(result.rows[0].locked_until);
    res.json({ success: true, lockedUntil: newLockedUntil });
  } catch (err) {
    console.error('POST /api/notes/:id/extend-lock error:', err);
    res.status(500).json({ error: 'Failed to extend lock' });
  }
});

app.post('/api/notes/:id/set-lock-until', async (req, res) => {
  try {
    const { timestamp, expectedUpdatedAt } = req.body;
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      return res.status(400).json({ error: 'Invalid lock timestamp' });
    }
    if (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0)) {
      return res.status(400).json({ error: 'Invalid note version' });
    }
    const requestStartedAt = Date.now();
    const result = await getPool().query(
      `UPDATE notes
       SET locked_until = $1, updated_at = GREATEST($2, updated_at + 1)
       WHERE id = $3
         AND (locked_until IS NULL OR locked_until <= $2 OR locked_until <= $1)
         AND ($4::bigint IS NULL OR (updated_at = $4 AND locked_until > $2))
         AND NOT EXISTS (
           SELECT 1 FROM accountability_unlock_events event
           WHERE event.note_id = notes.id AND event.unlocked_at >= $2
         )
       RETURNING locked_until`,
      [timestamp, requestStartedAt, req.params.id, expectedUpdatedAt ?? null]
    );
    if (result.rows.length === 0) {
      const existing = await getPool().query('SELECT locked_until, updated_at FROM notes WHERE id = $1', [req.params.id]);
      if (existing.rows.length === 0) return res.json({ success: false });
      const note = existing.rows[0];
      if (expectedUpdatedAt !== undefined
        && (Number(note.updated_at) !== expectedUpdatedAt || Number(note.locked_until) <= requestStartedAt)) {
        return res.status(409).json({ error: 'lock_changed' });
      }
      return res.status(409).json({
        error: 'lock_cannot_be_shortened',
        lockedUntil: Number(note.locked_until),
      });
    }
    res.json({ success: true, lockedUntil: timestamp });
  } catch (err) {
    console.error('POST /api/notes/:id/set-lock-until error:', err);
    res.status(500).json({ error: 'Failed to set lock' });
  }
});

app.post('/api/notes/:id/set-emergency-length', async (req, res) => {
  try {
    const { newLength } = req.body;
    const result = await getPool().query('SELECT emergency_length FROM notes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.json({ success: false });
    const current = result.rows[0].emergency_length || 50;
    if (newLength <= current) return res.json({ success: false });
    await getPool().query('UPDATE notes SET emergency_length = $1, updated_at = $2 WHERE id = $3', [newLength, Date.now(), req.params.id]);
    res.json({ success: true, emergencyLength: newLength });
  } catch (err) {
    console.error('POST /api/notes/:id/set-emergency-length error:', err);
    res.status(500).json({ error: 'Failed to set emergency length' });
  }
});

app.post('/api/notes/:id/emergency-unlock', async (req, res) => {
  try {
    const result = await getPool().query('SELECT * FROM notes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'not_found' });

    const note = result.rows[0];
    if (!note.locked_until || Number(note.locked_until) <= Date.now()) {
      return res.json({ success: false, error: 'not_locked' });
    }

    const schedule = note.schedule || { enabled: false, days: [], slots: [] };
    const disabledSchedule = { ...schedule, enabled: false };

    const updated = await getPool().query(
      'UPDATE notes SET locked_until = NULL, schedule_override_until = NULL, schedule = $1, updated_at = $2 WHERE id = $3 RETURNING *',
      [JSON.stringify(disabledSchedule), Date.now(), req.params.id]
    );
    res.json({ success: true, note: dbToNote(updated.rows[0]) });
  } catch (err) {
    console.error('POST /api/notes/:id/emergency-unlock error:', err);
    res.status(500).json({ error: 'Failed to emergency unlock' });
  }
});

app.post('/api/notes/:id/emergency-open', async (req, res) => {
  try {
    const result = await getPool().query('SELECT * FROM notes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.json({ success: false, error: 'not_found' });
    
    const note = result.rows[0];
    if (!note.emergency_open_enabled) return res.json({ success: false, error: 'not_enabled' });
    if (!note.locked_until || Number(note.locked_until) <= Date.now()) return res.json({ success: false, error: 'not_locked' });

    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysSinceMonday);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartMs = weekStart.getTime();

    const log: number[] = note.emergency_open_log || [];
    const usedThisWeek = log.filter((t: number) => t >= weekStartMs).length;

    if (usedThisWeek >= note.emergency_open_per_week) {
      return res.json({ success: false, error: 'quota_exhausted', usedThisWeek, limit: note.emergency_open_per_week });
    }

    const newLog = [...log, Date.now()];
    const schedule = note.schedule || { enabled: false, days: [], slots: [] };
    const disabledSchedule = { ...schedule, enabled: false };

    const updated = await getPool().query(
      'UPDATE notes SET locked_until = NULL, schedule_override_until = NULL, emergency_open_log = $1, updated_at = $2, schedule = $3 WHERE id = $4 RETURNING *',
      [JSON.stringify(newLog), Date.now(), JSON.stringify(disabledSchedule), req.params.id]
    );
    res.json({ success: true, usedThisWeek: usedThisWeek + 1, limit: note.emergency_open_per_week, note: dbToNote(updated.rows[0]) });
  } catch (err) {
    console.error('POST /api/notes/:id/emergency-open error:', err);
    res.status(500).json({ error: 'Failed to use emergency open' });
  }
});

app.post('/api/notes/apply-schedules', async (req, res) => {
  try {
    const clientTimezone = req.body?.timezone;
    const result = await getPool().query('SELECT * FROM notes WHERE deleted_at IS NULL');
    let anyUpdated = false;

    for (const row of result.rows) {
      const originalSchedule: NoteSchedule | null = row.schedule;
      const schedule = originalSchedule && withScheduleTimezone(originalSchedule, clientTimezone);
      if (!schedule?.enabled) continue;

      const now = Date.now();
      if (Number(row.locked_until) > now || Number(row.schedule_override_until) > now) continue;

      const slotEnd = getActiveSlotEnd(schedule, undefined, now)?.getTime();
      if (!slotEnd) continue;

      // A pre-timezone schedule can identify its active slot once the owner supplies a timezone.
      const lastPartnerUnlock = originalSchedule?.timezone ? null : await getLastPartnerUnlock(getPool(), row.id);
      const unlockedInThisSlot = lastPartnerUnlock !== null
        && getActiveSlotEnd(schedule, undefined, lastPartnerUnlock)?.getTime() === slotEnd;
      const updated = await getPool().query(
        `UPDATE notes
         SET locked_until = $1,
             schedule_override_until = $2,
             updated_at = GREATEST($3, updated_at + 1),
             schedule = $4
         WHERE id = $5 AND updated_at = $6 AND deleted_at IS NULL
           AND (locked_until IS NULL OR locked_until <= $3)
           AND (schedule_override_until IS NULL OR schedule_override_until <= $3)
         RETURNING id`,
        [unlockedInThisSlot ? null : slotEnd, unlockedInThisSlot ? slotEnd : null,
          now, JSON.stringify(schedule), row.id, row.updated_at]
      );
      if (updated.rows.length > 0) anyUpdated = true;
    }

    const updatedResult = await getPool().query('SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC');
    const notes = updatedResult.rows.map(dbToNote);
    res.json({ updated: anyUpdated, notes });
  } catch (err) {
    console.error('POST /api/notes/apply-schedules error:', err);
    res.status(500).json({ error: 'Failed to apply schedules' });
  }
});

app.post('/api/time/save', async (_req, res) => {
  try {
    const now = Date.now().toString();
    await getPool().query(
      `INSERT INTO app_state (key, value) VALUES ('last_known_time', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [now]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/time/save error:', err);
    res.status(500).json({ error: 'Failed to save time' });
  }
});

app.get('/api/time/last-known', async (_req, res) => {
  try {
    const result = await getPool().query("SELECT value FROM app_state WHERE key = 'last_known_time'");
    const time = result.rows.length > 0 ? Number(result.rows[0].value) : 0;
    res.json({ time });
  } catch (err) {
    console.error('GET /api/time/last-known error:', err);
    res.json({ time: 0 });
  }
});

async function getLastPartnerUnlock(db: PoolClient | Pool, noteId: string): Promise<number | null> {
  const result = await db.query(
    'SELECT unlocked_at FROM accountability_unlock_events WHERE note_id = $1 ORDER BY unlocked_at DESC LIMIT 1',
    [noteId],
  );
  return result.rows.length ? Number(result.rows[0].unlocked_at) : null;
}

function withScheduleTimezone(schedule: NoteSchedule, timezone: unknown): NoteSchedule {
  if (!schedule.enabled || schedule.timezone || typeof timezone !== 'string' || !timezone) return schedule;
  return { ...schedule, timezone };
}

function getTimeInTimezone(timezone: string, instant: Date): { day: number; hours: number; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(instant);

    const weekdayStr = parts.find(p => p.type === 'weekday')?.value || '';
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[weekdayStr] ?? instant.getDay();
    const hours = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minutes = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    return { day, hours, minutes };
  } catch {
    return { day: instant.getDay(), hours: instant.getHours(), minutes: instant.getMinutes() };
  }
}

function getSlotsForDay(schedule: NoteSchedule, day: number): ScheduleSlot[] {
  if (schedule.perDay && schedule.perDay[day]) {
    return schedule.perDay[day];
  }
  if (schedule.days && schedule.days.includes(day)) {
    return schedule.slots || [];
  }
  return [];
}

function getActiveSlotEnd(schedule: NoteSchedule, timezone?: string, now = Date.now()): Date | null {
  if (!schedule || !schedule.enabled) return null;

  const tz = timezone || schedule.timezone;
  const instant = new Date(now);
  const time = tz ? getTimeInTimezone(tz, instant) : {
    day: instant.getDay(), hours: instant.getHours(), minutes: instant.getMinutes(),
  };

  const slots = getSlotsForDay(schedule, time.day);
  if (slots.length === 0) return null;

  const nowMinutes = time.hours * 60 + time.minutes;

  for (const slot of slots) {
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    let isInSlot = false;
    if (startMinutes <= endMinutes) {
      isInSlot = nowMinutes >= startMinutes && nowMinutes < endMinutes;
    } else {
      isInSlot = nowMinutes >= startMinutes || nowMinutes < endMinutes;
    }

    if (isInSlot) {
      let minutesUntilEnd: number;
      if (endMinutes > nowMinutes) {
        minutesUntilEnd = endMinutes - nowMinutes;
      } else {
        minutesUntilEnd = (24 * 60 - nowMinutes) + endMinutes;
      }
      return new Date(Math.floor(now / 60_000) * 60_000 + minutesUntilEnd * 60_000);
    }
  }
  return null;
}

