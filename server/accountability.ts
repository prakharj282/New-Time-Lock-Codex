import crypto from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';

const ACCESS_ID = 1;
const ALWAYS_LOCKED_UNTIL = 253402300800000;
const INVITE_COOKIE = 'accountability_invite';
const SESSION_COOKIE = 'accountability_session';
const INVITE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_DURATION_MS = 15 * 60 * 1000;
const COOKIE_PATH = '/api/accountability';

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

interface AccountabilityDependencies {
  getPool: () => Pool;
  getEncryptionKey: () => string;
  getActiveSlotEnd: (schedule: NoteSchedule, timezone?: string) => Date | null;
}

interface AccessRow {
  id: number;
  invite_token_hash: Buffer;
  pin_hash: string | null;
  claimed_at: string | null;
  failed_attempts: number;
  rate_limited_until: string | null;
}

interface AuthenticatedSession {
  accessId: number;
  tokenHash: Buffer;
}

interface LockedNoteRow {
  id: string;
  title: string;
  locked_until: string | null;
  schedule: NoteSchedule | null;
  deleted_at: string | null;
  updated_at?: string | null;
}

type PartnerState = 'setup_required' | 'login_required' | 'authenticated' | 'revoked';
type LockKind = 'timer' | 'always' | 'schedule';
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export function isValidAccountabilityPin(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

function derivePinPepper(encryptionKey: string): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(encryptionKey, 'utf8'),
    Buffer.from('timelock-accountability-v1', 'utf8'),
    Buffer.from('pin-pepper', 'utf8'),
    32,
  ));
}

function scryptPin(pin: string, salt: Buffer, encryptionKey: string): Promise<Buffer> {
  const pepper = derivePinPepper(encryptionKey);
  const input = Buffer.concat([Buffer.from(pin, 'utf8'), Buffer.from([0]), pepper]);

  return new Promise((resolve, reject) => {
    crypto.scrypt(
      input,
      salt,
      32,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashAccountabilityPin(pin: string, encryptionKey: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptPin(pin, salt, encryptionKey);
  return `scrypt-v1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyAccountabilityPin(
  pin: string,
  storedHash: string,
  encryptionKey: string,
): Promise<boolean> {
  const [version, saltText, hashText, ...extra] = storedHash.split('$');
  if (version !== 'scrypt-v1' || !saltText || !hashText || extra.length > 0) return false;

  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length !== 16 || expected.length !== 32) return false;
    const actual = await scryptPin(pin, salt, encryptionKey);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function hashToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function hashesMatch(actual: Buffer | null | undefined, expected: Buffer): boolean {
  return !!actual && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of (req.headers.cookie || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (!name || Object.hasOwn(result, name)) continue;
    const rawValue = entry.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

function cookieValue(req: Request, name: string): string | null {
  const value = parseCookies(req)[name];
  return typeof value === 'string' ? value : null;
}

function appendCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function clearCookie(res: Response, name: string): void {
  const attributes = [
    `${name}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function setInviteCookie(res: Response, token: string): void {
  appendCookie(res, INVITE_COOKIE, token, INVITE_COOKIE_MAX_AGE_SECONDS);
}

function setSessionCookie(res: Response, token: string): void {
  appendCookie(res, SESSION_COOKIE, token, SESSION_MAX_AGE_MS / 1000);
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim();
}

function requestOrigins(req: Request): Set<string> {
  const origins = new Set<string>();
  const directHost = req.get('host');
  const forwardedHost = firstForwardedValue(req.get('x-forwarded-host'));
  const forwardedProto = firstForwardedValue(req.get('x-forwarded-proto'));

  for (const candidate of [
    directHost ? `${req.protocol}://${directHost}` : null,
    forwardedHost ? `${forwardedProto || req.protocol}://${forwardedHost}` : null,
  ]) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Invalid forwarded metadata is never trusted as an allowed origin.
    }
  }
  return origins;
}

function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const originHeader = req.get('origin');
  if (!originHeader) {
    res.status(403).json({ error: 'invalid_origin' });
    return;
  }

  try {
    if (!requestOrigins(req).has(new URL(originHeader).origin)) {
      res.status(403).json({ error: 'invalid_origin' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'invalid_origin' });
    return;
  }
  next();
}

function setPartnerResponseHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
  next();
}

function accessOwnerState(row: AccessRow | undefined): { state: 'none' | 'awaiting_setup' | 'active'; claimedAt?: number } {
  if (!row) return { state: 'none' };
  if (!row.pin_hash) return { state: 'awaiting_setup' };
  return { state: 'active', ...(row.claimed_at ? { claimedAt: Number(row.claimed_at) } : {}) };
}

function unauthenticatedPartnerState(row: AccessRow | undefined): PartnerState {
  if (!row) return 'revoked';
  return row.pin_hash ? 'login_required' : 'setup_required';
}

async function getAccess(queryable: Queryable, forUpdate = false): Promise<AccessRow | undefined> {
  const result = await queryable.query(
    `SELECT id, invite_token_hash, pin_hash, claimed_at, failed_attempts, rate_limited_until
     FROM accountability_access WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [ACCESS_ID],
  );
  return result.rows[0] as AccessRow | undefined;
}

function validInviteForAccess(req: Request, access: AccessRow | undefined): boolean {
  const rawToken = cookieValue(req, INVITE_COOKIE);
  return !!access && isValidToken(rawToken) && hashesMatch(access.invite_token_hash, hashToken(rawToken));
}

async function loadSession(queryable: Queryable, req: Request, lock = false): Promise<AuthenticatedSession | null> {
  const rawToken = cookieValue(req, SESSION_COOKIE);
  if (!isValidToken(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const result = await queryable.query(
    `SELECT s.access_id
     FROM accountability_sessions s
     JOIN accountability_access a ON a.id = s.access_id AND a.pin_hash IS NOT NULL
     WHERE s.token_hash = $1 AND s.expires_at > $2
     ${lock ? 'FOR SHARE OF s, a' : ''}`,
    [tokenHash, now],
  );
  if (result.rows.length === 0) return null;
  return { accessId: Number(result.rows[0].access_id), tokenHash };
}

async function createSession(client: PoolClient): Promise<string> {
  const rawToken = randomToken();
  const now = Date.now();
  await client.query(
    `INSERT INTO accountability_sessions (token_hash, access_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(rawToken), ACCESS_ID, now, now + SESSION_MAX_AGE_MS],
  );
  return rawToken;
}

function sendRateLimited(res: Response, retryAt: number): void {
  res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
  res.status(429).json({ error: 'rate_limited', retryAt });
}

async function recordFailedPin(client: PoolClient, row: AccessRow): Promise<number | null> {
  const rateLimitExpired = !!row.rate_limited_until
    && Number(row.rate_limited_until) <= Date.now();
  const attempts = (rateLimitExpired ? 0 : Number(row.failed_attempts || 0)) + 1;
  if (attempts >= RATE_LIMIT_ATTEMPTS) {
    const retryAt = Date.now() + RATE_LIMIT_DURATION_MS;
    await client.query(
      `UPDATE accountability_access
       SET failed_attempts = $4, rate_limited_until = $1, updated_at = $2
       WHERE id = $3`,
      [retryAt, Date.now(), ACCESS_ID, RATE_LIMIT_ATTEMPTS],
    );
    return retryAt;
  }

  await client.query(
    `UPDATE accountability_access
     SET failed_attempts = $1, rate_limited_until = NULL, updated_at = $2
     WHERE id = $3`,
    [attempts, Date.now(), ACCESS_ID],
  );
  return null;
}

function activeRateLimit(row: AccessRow): number | null {
  const retryAt = row.rate_limited_until ? Number(row.rate_limited_until) : 0;
  return retryAt > Date.now() ? retryAt : null;
}

function getScheduleWindowEnd(
  row: LockedNoteRow,
  getActiveSlotEnd: AccountabilityDependencies['getActiveSlotEnd'],
): number | null {
  const schedule = row.schedule;
  // Legacy schedules get their timezone from the owner's next schedule check.
  if (!schedule?.enabled || !schedule.timezone) return null;
  const end = getActiveSlotEnd(schedule, schedule.timezone)?.getTime();
  return end && end > Date.now() ? end : null;
}

function classifyLock(row: LockedNoteRow, scheduleWindowEnd: number | null): LockKind {
  const lockedUntil = Number(row.locked_until || 0);
  if (lockedUntil >= ALWAYS_LOCKED_UNTIL) return 'always';
  // Older scheduled locks stored their deadline with an offset of up to a minute.
  if (scheduleWindowEnd && Math.abs(scheduleWindowEnd - lockedUntil) < 2 * 60 * 1000) {
    return 'schedule';
  }
  return 'timer';
}

function logRouteFailure(operation: string): void {
  // Do not attach errors or request data here: accountability routes handle secrets.
  console.error(`Accountability operation failed: ${operation}`);
}

async function endBrowserSession(pool: Pool, req: Request, res: Response): Promise<void> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (isValidToken(token)) {
    await pool.query(
      'DELETE FROM accountability_sessions WHERE token_hash = $1',
      [hashToken(token)],
    );
  }
  clearCookie(res, SESSION_COOKIE);
}

export function createAccountabilityRouter(dependencies: AccountabilityDependencies): Router {
  const router = Router();
  router.use(setPartnerResponseHeaders);

  router.get('/access', async (_req, res) => {
    try {
      const row = await getAccess(dependencies.getPool());
      const key = process.env.PARTNER_MANAGEMENT_KEY;
      res.json({
        ...accessOwnerState(row),
        ...(key && key.length >= 32 ? { canReplace: true } : {}),
      });
    } catch {
      logRouteFailure('get access');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/access', requireSameOrigin, async (_req, res) => {
    const token = randomToken();
    const now = Date.now();
    try {
      const result = await dependencies.getPool().query(
        `INSERT INTO accountability_access
          (id, invite_token_hash, pin_hash, claimed_at, failed_attempts, rate_limited_until, created_at, updated_at)
         VALUES ($1, $2, NULL, NULL, 0, NULL, $3, $3)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [ACCESS_ID, hashToken(token), now],
      );
      if (result.rows.length === 0) {
        res.status(409).json({ error: 'access_exists' });
        return;
      }
      res.json({ state: 'awaiting_setup', token });
    } catch {
      logRouteFailure('create access');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/access/replace', requireSameOrigin, async (req, res) => {
    const key = process.env.PARTNER_MANAGEMENT_KEY;
    const suppliedKey = req.body?.managementKey;
    if (!key || key.length < 32 || typeof suppliedKey !== 'string'
      || !hashesMatch(hashToken(suppliedKey), hashToken(key))) {
      res.status(403).json({ error: 'invalid_management_key' });
      return;
    }

    const token = randomToken();
    try {
      const client = await dependencies.getPool().connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE accountability_access
           SET invite_token_hash = $2, pin_hash = NULL, claimed_at = NULL,
               failed_attempts = 0, rate_limited_until = NULL, updated_at = $3
           WHERE id = $1 RETURNING id`,
          [ACCESS_ID, hashToken(token), Date.now()],
        );
        if (!result.rowCount) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'access_not_found' });
          return;
        }
        await client.query('DELETE FROM accountability_sessions WHERE access_id = $1', [ACCESS_ID]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      res.json({ state: 'awaiting_setup', token });
    } catch {
      logRouteFailure('replace access');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/bootstrap', requireSameOrigin, async (req, res) => {
    const token = req.body?.token;
    if (!isValidToken(token)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const access = await getAccess(dependencies.getPool());
      if (!access || !hashesMatch(access.invite_token_hash, hashToken(token))) {
        clearCookie(res, INVITE_COOKIE);
        clearCookie(res, SESSION_COOKIE);
        res.json({ state: 'revoked' });
        return;
      }

      await endBrowserSession(dependencies.getPool(), req, res);
      setInviteCookie(res, token);
      res.json({ state: unauthenticatedPartnerState(access) });
    } catch {
      logRouteFailure('bootstrap');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/claim', requireSameOrigin, async (req, res) => {
    const { pin, pinConfirmation } = req.body || {};
    if (!isValidAccountabilityPin(pin) || pinConfirmation !== pin) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const inviteToken = cookieValue(req, INVITE_COOKIE);
    if (!isValidToken(inviteToken)) {
      res.status(401).json({ error: 'invalid_invitation' });
      return;
    }

    const client = await dependencies.getPool().connect();
    try {
      await client.query('BEGIN');
      const access = await getAccess(client, true);
      if (!access || !hashesMatch(access.invite_token_hash, hashToken(inviteToken))) {
        await client.query('ROLLBACK');
        res.status(401).json({ error: 'invalid_invitation' });
        return;
      }
      if (access.pin_hash) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'already_claimed' });
        return;
      }

      const pinHash = await hashAccountabilityPin(pin, dependencies.getEncryptionKey());
      const now = Date.now();
      await client.query(
        `UPDATE accountability_access
         SET pin_hash = $1, claimed_at = $2, failed_attempts = 0,
             rate_limited_until = NULL, updated_at = $2
         WHERE id = $3`,
        [pinHash, now, ACCESS_ID],
      );
      await client.query('DELETE FROM accountability_sessions WHERE access_id = $1', [ACCESS_ID]);
      const sessionToken = await createSession(client);
      await client.query('COMMIT');
      setSessionCookie(res, sessionToken);
      res.status(201).json({ state: 'authenticated' });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      logRouteFailure('claim');
      res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }
  });

  router.post('/login', requireSameOrigin, async (req, res) => {
    const { pin } = req.body || {};
    if (!isValidAccountabilityPin(pin)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const inviteToken = cookieValue(req, INVITE_COOKIE);
    if (!isValidToken(inviteToken)) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    const client = await dependencies.getPool().connect();
    try {
      await client.query('BEGIN');
      const access = await getAccess(client, true);
      if (!access || !access.pin_hash || !hashesMatch(access.invite_token_hash, hashToken(inviteToken))) {
        await client.query('ROLLBACK');
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }

      const retryAt = activeRateLimit(access);
      if (retryAt) {
        await client.query('ROLLBACK');
        sendRateLimited(res, retryAt);
        return;
      }

      const valid = await verifyAccountabilityPin(pin, access.pin_hash, dependencies.getEncryptionKey());
      if (!valid) {
        const nextRetryAt = await recordFailedPin(client, access);
        await client.query('COMMIT');
        if (nextRetryAt) sendRateLimited(res, nextRetryAt);
        else res.status(401).json({ error: 'invalid_credentials' });
        return;
      }

      await client.query(
        `UPDATE accountability_access
         SET failed_attempts = 0, rate_limited_until = NULL, updated_at = $1
         WHERE id = $2`,
        [Date.now(), ACCESS_ID],
      );
      await client.query('DELETE FROM accountability_sessions WHERE expires_at <= $1', [Date.now()]);
      const sessionToken = await createSession(client);
      await client.query('COMMIT');
      setSessionCookie(res, sessionToken);
      res.json({ state: 'authenticated' });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      logRouteFailure('login');
      res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }
  });

  router.get('/session', async (req, res) => {
    try {
      const session = await loadSession(dependencies.getPool(), req);
      if (session) {
        res.json({ state: 'authenticated' });
        return;
      }
      clearCookie(res, SESSION_COOKIE);

      const access = await getAccess(dependencies.getPool());
      if (!validInviteForAccess(req, access)) {
        res.json({ state: 'revoked' });
        return;
      }
      res.json({ state: unauthenticatedPartnerState(access) });
    } catch {
      logRouteFailure('get session');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/logout', requireSameOrigin, async (req, res) => {
    try {
      await endBrowserSession(dependencies.getPool(), req, res);
      const access = await getAccess(dependencies.getPool());
      res.json({
        state: validInviteForAccess(req, access) ? unauthenticatedPartnerState(access) : 'revoked',
      });
    } catch {
      logRouteFailure('logout');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/pin', requireSameOrigin, async (req, res) => {
    const { currentPin, newPin, newPinConfirmation } = req.body || {};
    if (
      !isValidAccountabilityPin(currentPin)
      || !isValidAccountabilityPin(newPin)
      || newPinConfirmation !== newPin
    ) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const rawSession = cookieValue(req, SESSION_COOKIE);
    if (!isValidToken(rawSession)) {
      clearCookie(res, SESSION_COOKIE);
      res.status(401).json({ error: 'session_expired' });
      return;
    }

    const client = await dependencies.getPool().connect();
    try {
      await client.query('BEGIN');
      const sessionHash = hashToken(rawSession);
      const result = await client.query(
        `SELECT a.id, a.invite_token_hash, a.pin_hash, a.claimed_at,
                a.failed_attempts, a.rate_limited_until
         FROM accountability_sessions s
         JOIN accountability_access a ON a.id = s.access_id
         WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.pin_hash IS NOT NULL
         FOR UPDATE OF s, a`,
        [sessionHash, Date.now()],
      );
      const access = result.rows[0] as AccessRow | undefined;
      if (!access?.pin_hash) {
        await client.query('ROLLBACK');
        clearCookie(res, SESSION_COOKIE);
        res.status(401).json({ error: 'session_expired' });
        return;
      }

      const retryAt = activeRateLimit(access);
      if (retryAt) {
        await client.query('ROLLBACK');
        sendRateLimited(res, retryAt);
        return;
      }

      const valid = await verifyAccountabilityPin(currentPin, access.pin_hash, dependencies.getEncryptionKey());
      if (!valid) {
        const nextRetryAt = await recordFailedPin(client, access);
        await client.query('COMMIT');
        if (nextRetryAt) sendRateLimited(res, nextRetryAt);
        else res.status(401).json({ error: 'invalid_credentials' });
        return;
      }

      const pinHash = await hashAccountabilityPin(newPin, dependencies.getEncryptionKey());
      await client.query(
        `UPDATE accountability_access
         SET pin_hash = $1, failed_attempts = 0, rate_limited_until = NULL, updated_at = $2
         WHERE id = $3`,
        [pinHash, Date.now(), ACCESS_ID],
      );
      await client.query('DELETE FROM accountability_sessions WHERE access_id = $1', [ACCESS_ID]);
      const newSessionToken = await createSession(client);
      await client.query('COMMIT');
      setSessionCookie(res, newSessionToken);
      res.json({ state: 'authenticated' });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      logRouteFailure('change pin');
      res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }
  });

  router.get('/notes', async (req, res) => {
    try {
      const session = await loadSession(dependencies.getPool(), req);
      if (!session) {
        clearCookie(res, SESSION_COOKIE);
        res.status(401).json({ error: 'session_expired' });
        return;
      }

      const result = await dependencies.getPool().query(
        `SELECT id, title, locked_until, schedule, deleted_at
         FROM notes
         WHERE deleted_at IS NULL AND locked_until > $1
         ORDER BY created_at DESC`,
        [Date.now()],
      );
      const notes = (result.rows as LockedNoteRow[]).map((row) => {
        const kind = classifyLock(row, getScheduleWindowEnd(row, dependencies.getActiveSlotEnd));
        return {
          id: row.id,
          title: row.title,
          lockKind: kind,
          lockedUntil: kind === 'always' ? null : Number(row.locked_until),
        };
      });
      res.json({ notes });
    } catch {
      logRouteFailure('list notes');
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.post('/notes/:id/unlock', requireSameOrigin, async (req, res) => {
    const rawSession = cookieValue(req, SESSION_COOKIE);
    if (!isValidToken(rawSession)) {
      clearCookie(res, SESSION_COOKIE);
      res.status(401).json({ error: 'session_expired' });
      return;
    }

    const client = await dependencies.getPool().connect();
    try {
      await client.query('BEGIN');
      const sessionHash = hashToken(rawSession);
      const sessionResult = await client.query(
        `SELECT s.access_id
         FROM accountability_sessions s
         JOIN accountability_access a ON a.id = s.access_id AND a.pin_hash IS NOT NULL
         WHERE s.token_hash = $1 AND s.expires_at > $2
         FOR SHARE OF s, a`,
        [sessionHash, Date.now()],
      );
      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        clearCookie(res, SESSION_COOKIE);
        res.status(401).json({ error: 'session_expired' });
        return;
      }

      const noteResult = await client.query(
        `SELECT id, title, locked_until, schedule, deleted_at, updated_at
         FROM notes WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const note = noteResult.rows[0] as LockedNoteRow | undefined;
      if (!note || note.deleted_at) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const previousLockedUntil = Number(note.locked_until || 0);
      if (!previousLockedUntil || previousLockedUntil <= Date.now()) {
        await client.query('COMMIT');
        res.json({ success: true, result: 'already_unlocked' });
        return;
      }

      const scheduleWindowEnd = getScheduleWindowEnd(note, dependencies.getActiveSlotEnd);
      const kind = classifyLock(note, scheduleWindowEnd);
      const now = Math.max(Date.now(), Number(note.updated_at || 0) + 1);
      await client.query(
        `UPDATE notes
         SET locked_until = NULL, schedule_override_until = $1, updated_at = $2
         WHERE id = $3`,
        [scheduleWindowEnd, now, note.id],
      );
      await client.query(
        `INSERT INTO accountability_unlock_events
          (note_id, access_id, unlocked_at, lock_kind, previous_locked_until, schedule_override_until)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [note.id, ACCESS_ID, now, kind, previousLockedUntil, scheduleWindowEnd],
      );
      await client.query('COMMIT');
      res.json({ success: true, result: 'unlocked' });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      logRouteFailure('unlock note');
      res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }
  });

  return router;
}
