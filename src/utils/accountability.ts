export type AccountabilityAccessState = 'none' | 'awaiting_setup' | 'active';

export type PartnerAuthState =
  | 'setup_required'
  | 'login_required'
  | 'authenticated'
  | 'revoked';

export interface AccountabilityAccess {
  state: AccountabilityAccessState;
  claimedAt: number | null;
}

export interface CreatedAccountabilityAccess {
  state: 'awaiting_setup';
  shareUrl: string;
}

export interface PartnerAuthResult {
  state: PartnerAuthState;
  retryAt: number | null;
}

export interface PartnerNote {
  id: string;
  title: string;
  lockKind: string;
  lockedUntil: number | string | null;
}

export type PartnerUnlockResult = 'unlocked' | 'already_unlocked' | 'not_found';

type JsonRecord = Record<string, unknown>;

const API_ROOT = '/api/accountability';
const SIX_DIGIT_PIN = /^\d{6}$/;

export class AccountabilityApiError extends Error {
  readonly code: string;
  readonly retryAt: number | null;
  readonly status: number;

  constructor(code: string, status: number, retryAt: number | null = null) {
    super(code);
    this.name = 'AccountabilityApiError';
    this.code = code;
    this.retryAt = retryAt;
    this.status = status;
  }
}

export function isAccountabilityApiError(error: unknown): error is AccountabilityApiError {
  return error instanceof AccountabilityApiError;
}

export function sanitizePartnerPin(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

export function isValidPartnerPin(value: string): boolean {
  return SIX_DIGIT_PIN.test(value);
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {};
}

function normalizeEpoch(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeEpoch(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value < 100_000_000) return Date.now() + value * 1000;
  if (value < 100_000_000_000) return value * 1000;
  return value;
}

async function request(path: string, init: RequestInit = {}): Promise<JsonRecord> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new AccountabilityApiError('network_error', 0);
  }

  let payload: JsonRecord = {};
  const text = await response.text();
  if (text) {
    try {
      payload = asRecord(JSON.parse(text));
    } catch {
      if (!response.ok) throw new AccountabilityApiError('request_failed', response.status);
      throw new AccountabilityApiError('invalid_response', response.status);
    }
  }

  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : 'request_failed';
    let retryAt = normalizeEpoch(payload.retryAt ?? payload.retryAfterSeconds);
    if (retryAt === null) {
      const retryAfter = response.headers.get('Retry-After');
      retryAt = normalizeEpoch(retryAfter);
    }
    throw new AccountabilityApiError(code, response.status, retryAt);
  }

  return payload;
}

function jsonBody(value: JsonRecord): string {
  return JSON.stringify(value);
}

function normalizeAccessState(payload: JsonRecord): AccountabilityAccessState {
  const raw = payload.state ?? payload.status;
  if (raw === 'awaiting_setup' || raw === 'setup_required') return 'awaiting_setup';
  if (raw === 'active' || raw === 'authenticated' || raw === 'login_required') return 'active';
  return 'none';
}

function normalizeAuthResult(payload: JsonRecord): PartnerAuthResult {
  const raw = payload.state ?? payload.status;
  let state: PartnerAuthState;

  if (raw === 'setup_required' || raw === 'awaiting_setup') {
    state = 'setup_required';
  } else if (raw === 'login_required') {
    state = 'login_required';
  } else if (raw === 'authenticated' || payload.authenticated === true) {
    state = 'authenticated';
  } else if (raw === 'active') {
    state = payload.authenticated === false ? 'login_required' : 'authenticated';
  } else {
    state = 'revoked';
  }

  return {
    state,
    retryAt: normalizeEpoch(payload.retryAt ?? payload.retryAfterSeconds),
  };
}

function buildShareUrl(token: string): string {
  return `${window.location.origin}/partner#${encodeURIComponent(token)}`;
}

export async function getAccountabilityAccess(): Promise<AccountabilityAccess> {
  const payload = await request('/access');
  return {
    state: normalizeAccessState(payload),
    claimedAt: normalizeEpoch(payload.claimedAt),
  };
}

export async function createAccountabilityAccess(): Promise<CreatedAccountabilityAccess> {
  return issueAccountabilityAccess('/access');
}

export async function rotateAccountabilityAccess(): Promise<CreatedAccountabilityAccess> {
  return issueAccountabilityAccess('/access/rotate');
}

async function issueAccountabilityAccess(path: string): Promise<CreatedAccountabilityAccess> {
  const payload = await request(path, { method: 'POST', body: jsonBody({}) });
  const token = typeof payload.token === 'string' ? payload.token : '';
  const shareUrl = typeof payload.shareUrl === 'string'
    ? payload.shareUrl
    : token ? buildShareUrl(token) : '';

  if (!shareUrl) throw new AccountabilityApiError('invalid_response', 200);
  return { state: 'awaiting_setup', shareUrl };
}

export async function revokeAccountabilityAccess(): Promise<void> {
  await request('/access', { method: 'DELETE' });
}

export async function bootstrapPartnerInvitation(token: string): Promise<PartnerAuthResult> {
  const payload = await request('/bootstrap', {
    method: 'POST',
    body: jsonBody({ token }),
  });
  return normalizeAuthResult(payload);
}

export async function getPartnerSession(): Promise<PartnerAuthResult> {
  return normalizeAuthResult(await request('/session'));
}

export async function claimPartnerInvitation(
  pin: string,
  pinConfirmation: string,
): Promise<PartnerAuthResult> {
  const payload = await request('/claim', {
    method: 'POST',
    body: jsonBody({ pin, pinConfirmation }),
  });
  return normalizeAuthResult(payload);
}

export async function loginPartner(pin: string): Promise<PartnerAuthResult> {
  const payload = await request('/login', {
    method: 'POST',
    body: jsonBody({ pin }),
  });
  return normalizeAuthResult(payload);
}

export async function logoutPartner(): Promise<PartnerAuthResult> {
  const payload = await request('/logout', { method: 'POST', body: jsonBody({}) });
  return normalizeAuthResult(payload);
}

export async function changePartnerPin(
  currentPin: string,
  newPin: string,
  newPinConfirmation: string,
): Promise<void> {
  await request('/pin', {
    method: 'POST',
    body: jsonBody({ currentPin, newPin, newPinConfirmation }),
  });
}

export async function getPartnerNotes(): Promise<PartnerNote[]> {
  const payload = await request('/notes');
  if (!Array.isArray(payload.notes)) return [];

  return payload.notes.flatMap((value): PartnerNote[] => {
    const note = asRecord(value);
    if (typeof note.id !== 'string') return [];
    const lockedUntil = typeof note.lockedUntil === 'number' || typeof note.lockedUntil === 'string'
      ? note.lockedUntil
      : null;

    return [{
      id: note.id,
      title: typeof note.title === 'string' && note.title.trim() ? note.title : 'Untitled note',
      lockKind: typeof note.lockKind === 'string' ? note.lockKind : 'locked',
      lockedUntil,
    }];
  });
}

export async function unlockPartnerNote(noteId: string): Promise<PartnerUnlockResult> {
  let payload: JsonRecord;
  try {
    payload = await request(`/notes/${encodeURIComponent(noteId)}/unlock`, {
      method: 'POST',
      body: jsonBody({}),
    });
  } catch (error) {
    if (isAccountabilityApiError(error)
      && error.status === 404
      && error.code === 'not_found') {
      return 'not_found';
    }
    throw error;
  }
  const result = payload.result ?? payload.status;
  if (result === 'already_unlocked' || result === 'not_found') return result;
  return 'unlocked';
}
