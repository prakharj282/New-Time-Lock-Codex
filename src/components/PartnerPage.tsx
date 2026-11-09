import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PartnerAuthResult, PartnerNote } from '../utils/accountability';
import {
  AccountabilityApiError,
  bootstrapPartnerInvitation,
  changePartnerPin,
  claimPartnerInvitation,
  getPartnerNotes,
  getPartnerSession,
  isAccountabilityApiError,
  isValidPartnerPin,
  loginPartner,
  logoutPartner,
  sanitizePartnerPin,
  unlockPartnerNote,
} from '../utils/accountability';
import '../accountability.css';

type PartnerScreen =
  | 'loading'
  | 'connection_error'
  | 'setup'
  | 'login'
  | 'dashboard'
  | 'settings'
  | 'unavailable';

interface PinFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
}

interface UnlockConfirmationProps {
  note: PartnerNote;
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function PinField({
  id,
  label,
  value,
  onChange,
  testId,
  autoComplete,
  autoFocus = false,
}: PinFieldProps) {
  return (
    <label className="partner-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        value={value}
        onChange={(event) => onChange(sanitizePartnerPin(event.currentTarget.value))}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        enterKeyHint="done"
        data-testid={testId}
      />
    </label>
  );
}

function LockMark() {
  return (
    <span className="partner-lock-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="10" width="16" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    </span>
  );
}

function UnlockConfirmation({ note, isBusy, onCancel, onConfirm }: UnlockConfirmationProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy) onCancel();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLButtonElement>(
        'button:not([disabled])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isBusy, onCancel]);

  return (
    <div className="partner-dialog-backdrop">
      <section
        ref={dialogRef}
        className="partner-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="partner-unlock-title"
        aria-describedby="partner-unlock-description"
        data-testid="partner-unlock-confirmation"
      >
        <div className="partner-dialog-icon"><LockMark /></div>
        <h2 id="partner-unlock-title">Unlock this note?</h2>
        <p id="partner-unlock-description">
          <strong>{note.title}</strong> will become available to its owner immediately.
          You will not see its contents.
        </p>
        <div className="partner-button-row">
          <button
            ref={cancelButtonRef}
            type="button"
            className="partner-button is-secondary"
            onClick={onCancel}
            disabled={isBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="partner-button"
            onClick={onConfirm}
            disabled={isBusy}
            data-testid="partner-unlock-confirm"
          >
            {isBusy ? 'Unlocking…' : 'Unlock note'}
          </button>
        </div>
      </section>
    </div>
  );
}

function readFragmentToken(): string | null {
  const fragment = window.location.hash.slice(1).trim();
  if (!fragment) return null;
  try {
    if (fragment.startsWith('token=')) {
      return new URLSearchParams(fragment).get('token');
    }
    return decodeURIComponent(fragment);
  } catch {
    return null;
  }
}

function formatLockKind(lockKind: string): string {
  const normalized = lockKind.toLowerCase();
  if (normalized.includes('schedule')) return 'Scheduled lock';
  if (normalized.includes('always') || normalized.includes('permanent')) return 'Always locked';
  if (normalized.includes('timer') || normalized.includes('time')) return 'Timed lock';
  return 'Locked';
}

function formatLockedUntil(note: PartnerNote): string {
  const normalizedKind = note.lockKind.toLowerCase();
  if (normalizedKind.includes('always') || normalizedKind.includes('permanent')) {
    return 'No automatic unlock';
  }

  if (note.lockedUntil === null) {
    return normalizedKind.includes('schedule') ? 'Current schedule window' : 'Currently locked';
  }

  const raw = typeof note.lockedUntil === 'number'
    ? note.lockedUntil
    : Date.parse(note.lockedUntil);
  const timestamp = typeof raw === 'number' && raw > 0 && raw < 100_000_000_000
    ? raw * 1000
    : raw;
  if (!Number.isFinite(timestamp)) return 'Currently locked';

  try {
    return `Until ${DATE_FORMATTER.format(new Date(timestamp))}`;
  } catch {
    return 'Currently locked';
  }
}

function formatRetryTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${remainder.toString().padStart(2, '0')}` : `${remainder}s`;
}

function fallbackRetryAt(error: AccountabilityApiError): number {
  return error.retryAt ?? Date.now() + 15 * 60_000;
}

export default function PartnerPage() {
  const [screen, setScreen] = useState<PartnerScreen>('loading');
  const [notes, setNotes] = useState<PartnerNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [setupPin, setSetupPin] = useState('');
  const [setupConfirmation, setSetupConfirmation] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPinConfirmation, setNewPinConfirmation] = useState('');
  const [pendingUnlock, setPendingUnlock] = useState<PartnerNote | null>(null);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const initializationStartedRef = useRef(false);

  const applyAuthResult = useCallback((result: PartnerAuthResult) => {
    setError('');
    if (result.retryAt) {
      setRetryUntil(result.retryAt);
      setClock(Date.now());
    } else {
      setRetryUntil(null);
    }

    if (result.state === 'authenticated') {
      setScreen('dashboard');
    } else if (result.state === 'setup_required') {
      setScreen('setup');
    } else if (result.state === 'login_required') {
      setScreen('login');
    } else {
      setScreen('unavailable');
    }
  }, []);

  const initialize = useCallback(async () => {
    const token = readFragmentToken();

    setScreen('loading');
    setError('');
    try {
      const result = token
        ? await bootstrapPartnerInvitation(token)
        : await logoutPartner();
      applyAuthResult(result);
    } catch (initialError) {
      if (isAccountabilityApiError(initialError)
        && (initialError.code === 'invalid_request'
          || initialError.code === 'invalid_invitation'
          || initialError.code === 'revoked')) {
        setScreen('unavailable');
        return;
      }
      setError('Could not connect to TimeLock Notes. Check your connection and try again.');
      setScreen('connection_error');
    }
  }, [applyAuthResult]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Partner Access · TimeLock Notes';
    let robotsMeta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const createdRobotsMeta = robotsMeta === null;
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    const previousRobotsContent = robotsMeta.content;
    robotsMeta.content = 'noindex, nofollow, noarchive';

    return () => {
      document.title = previousTitle;
      if (createdRobotsMeta) robotsMeta?.remove();
      else if (robotsMeta) robotsMeta.content = previousRobotsContent;
    };
  }, []);

  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const reopenInvitation = () => {
      if (window.location.hash) window.location.reload();
    };
    const reopenFromHistory = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('hashchange', reopenInvitation);
    window.addEventListener('pageshow', reopenFromHistory);
    return () => {
      window.removeEventListener('hashchange', reopenInvitation);
      window.removeEventListener('pageshow', reopenFromHistory);
    };
  }, []);

  useEffect(() => {
    if (!retryUntil) return;
    const updateClock = () => {
      const now = Date.now();
      setClock(now);
      if (now >= retryUntil) {
        setRetryUntil(null);
        setError('');
      }
    };
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  const resolveLostSession = useCallback(async () => {
    setNotes([]);
    setPendingUnlock(null);
    setUnlockingId(null);
    try {
      const result = await getPartnerSession();
      applyAuthResult(result);
      if (result.state === 'login_required') {
        setNotice('Your session expired. Enter your PIN to continue.');
      } else {
        setNotice('');
      }
    } catch {
      setError('Could not connect to TimeLock Notes. Check your connection and try again.');
      setScreen('connection_error');
    }
  }, [applyAuthResult]);

  const handleProtectedError = useCallback(async (
    requestError: unknown,
    invalidPinText?: string,
  ) => {
    if (!isAccountabilityApiError(requestError)) {
      setError('Something went wrong. Please try again.');
      return;
    }

    if (requestError.code === 'invalid_invitation' || requestError.code === 'revoked') {
      setScreen('unavailable');
      setNotes([]);
      setPendingUnlock(null);
      setUnlockingId(null);
      return;
    }

    if (requestError.code === 'invalid_pin'
      || requestError.code === 'invalid_credentials') {
      setError(invalidPinText ?? 'That PIN was not accepted. Try again.');
      return;
    }

    if (requestError.code === 'session_expired'
      || requestError.code === 'unauthorized'
      || requestError.status === 401) {
      setError('');
      await resolveLostSession();
      return;
    }

    if (requestError.code === 'rate_limited' || requestError.status === 429) {
      setRetryUntil(fallbackRetryAt(requestError));
      setClock(Date.now());
      setError('Too many unsuccessful attempts. Try again after the cooldown.');
      return;
    }

    if (requestError.status === 403) {
      setError(invalidPinText ?? 'That PIN was not accepted. Try again.');
      return;
    }

    if (requestError.code === 'network_error') {
      setError('Could not reach the server. Check your connection and try again.');
      return;
    }

    setError('The request could not be completed. Please try again.');
  }, [resolveLostSession]);

  const loadNotes = useCallback(async (silent: boolean) => {
    if (!silent) setNotesLoading(true);
    try {
      const nextNotes = await getPartnerNotes();
      setNotes(nextNotes);
      setError('');
    } catch (loadError) {
      await handleProtectedError(loadError);
    } finally {
      if (!silent) setNotesLoading(false);
    }
  }, [handleProtectedError]);

  useEffect(() => {
    if (screen !== 'dashboard') return;
    void loadNotes(false);

    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadNotes(true);
    }, 10_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadNotes(true);
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadNotes, screen]);

  const retrySeconds = retryUntil ? Math.max(0, Math.ceil((retryUntil - clock) / 1000)) : 0;
  const rateLimited = retrySeconds > 0;
  const visibleError = rateLimited
    ? `Too many unsuccessful attempts. Try again in ${formatRetryTime(retrySeconds)}.`
    : error;

  const submitSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    if (!isValidPartnerPin(setupPin)) {
      setError('Enter exactly six digits.');
      return;
    }
    if (setupPin !== setupConfirmation) {
      setError('The PINs do not match.');
      return;
    }

    setIsBusy(true);
    setError('');
    try {
      const result = await claimPartnerInvitation(setupPin, setupConfirmation);
      setSetupPin('');
      setSetupConfirmation('');
      setNotice('Your PIN is set. You can now help unlock notes.');
      applyAuthResult(result);
    } catch (claimError) {
      setSetupPin('');
      setSetupConfirmation('');
      if (isAccountabilityApiError(claimError)
        && claimError.status === 409
        && claimError.code === 'already_claimed') {
        try {
          const result = await getPartnerSession();
          applyAuthResult(result);
          if (result.state === 'login_required') {
            setNotice('A PIN was just created for this link. Enter it to continue.');
          }
        } catch (sessionError) {
          await handleProtectedError(sessionError);
        }
      } else {
        await handleProtectedError(claimError, 'The PIN could not be set. Use exactly six digits.');
      }
    } finally {
      setIsBusy(false);
    }
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    if (!isValidPartnerPin(loginPin)) {
      setError('Enter your six-digit PIN.');
      return;
    }

    setIsBusy(true);
    setError('');
    try {
      const result = await loginPartner(loginPin);
      setLoginPin('');
      applyAuthResult(result);
    } catch (loginError) {
      setLoginPin('');
      await handleProtectedError(loginError);
    } finally {
      setIsBusy(false);
    }
  };

  const submitPinChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    if (!isValidPartnerPin(currentPin) || !isValidPartnerPin(newPin)) {
      setError('Both the current and new PIN must contain exactly six digits.');
      return;
    }
    if (newPin !== newPinConfirmation) {
      setError('The new PINs do not match.');
      return;
    }

    setIsBusy(true);
    setError('');
    try {
      await changePartnerPin(currentPin, newPin, newPinConfirmation);
      setCurrentPin('');
      setNewPin('');
      setNewPinConfirmation('');
      setNotice('PIN changed. Other signed-in partner sessions were ended.');
      setScreen('dashboard');
    } catch (changeError) {
      setCurrentPin('');
      setNewPin('');
      setNewPinConfirmation('');
      await handleProtectedError(changeError, 'The current PIN was not accepted.');
    } finally {
      setIsBusy(false);
    }
  };

  const signOut = async () => {
    setIsBusy(true);
    setError('');
    try {
      const result = await logoutPartner();
      setNotes([]);
      applyAuthResult(result);
      setNotice(result.state === 'login_required' ? 'You are signed out.' : '');
    } catch (logoutError) {
      await handleProtectedError(logoutError);
    } finally {
      setIsBusy(false);
    }
  };

  const confirmUnlock = async () => {
    if (!pendingUnlock) return;
    const note = pendingUnlock;
    setUnlockingId(note.id);
    setError('');
    setNotice('');
    try {
      const result = await unlockPartnerNote(note.id);
      setPendingUnlock(null);
      setNotice(result === 'unlocked'
        ? `“${note.title}” is unlocked for its owner.`
        : result === 'already_unlocked'
          ? `“${note.title}” was already unlocked.`
          : `“${note.title}” is no longer available to unlock.`);
      await loadNotes(true);
    } catch (unlockError) {
      await handleProtectedError(unlockError);
    } finally {
      setUnlockingId(null);
    }
  };

  const openSettings = () => {
    setError('');
    setNotice('');
    setCurrentPin('');
    setNewPin('');
    setNewPinConfirmation('');
    setScreen('settings');
  };

  return (
    <div className="partner-page" data-testid="partner-page">
      <main className="partner-shell">
        <header className="partner-brand">
          <LockMark />
          <div>
            <span>TimeLock Notes</span>
            <strong>Partner Access</strong>
          </div>
        </header>

        {visibleError ? <div className="partner-alert is-error" role="alert">{visibleError}</div> : null}
        {notice ? <div className="partner-alert is-success" role="status">{notice}</div> : null}

        {screen === 'loading' ? (
          <section className="partner-card is-centered" aria-busy="true">
            <div className="partner-spinner" aria-hidden="true" />
            <h1>Opening partner access</h1>
            <p>Checking this private link…</p>
          </section>
        ) : null}

        {screen === 'connection_error' ? (
          <section className="partner-card is-centered">
            <h1>Connection problem</h1>
            <p>Partner access could not be loaded right now.</p>
            <button type="button" className="partner-button" onClick={() => void initialize()}>
              Try again
            </button>
          </section>
        ) : null}

        {screen === 'unavailable' ? (
          <section className="partner-card is-centered" data-testid="partner-link-unavailable">
            <div className="partner-state-icon" aria-hidden="true">×</div>
            <h1>This link is unavailable</h1>
            <p>Open the full partner invitation, including the part after the #.</p>
          </section>
        ) : null}

        {screen === 'setup' ? (
          <section className="partner-card">
            <p className="partner-eyebrow">First-time setup</p>
            <h1>Create your private PIN</h1>
            <p className="partner-card-copy">
              Choose six digits only you know. The note owner cannot set or view this PIN.
            </p>
            <form className="partner-form" onSubmit={submitSetup} data-testid="partner-setup-form">
              <PinField
                id="partner-setup-pin"
                label="Six-digit PIN"
                value={setupPin}
                onChange={setSetupPin}
                testId="partner-setup-pin"
                autoComplete="new-password"
                autoFocus
              />
              <PinField
                id="partner-setup-confirm"
                label="Confirm PIN"
                value={setupConfirmation}
                onChange={setSetupConfirmation}
                testId="partner-setup-confirm"
                autoComplete="new-password"
              />
              <p className="partner-form-hint">Keep this PIN safe. It is required on each visit and cannot be recovered.</p>
              <button
                type="submit"
                className="partner-button is-full"
                disabled={isBusy || rateLimited}
                data-testid="partner-setup-submit"
              >
                {isBusy ? 'Setting PIN…' : 'Set PIN and continue'}
              </button>
            </form>
          </section>
        ) : null}

        {screen === 'login' ? (
          <section className="partner-card">
            <p className="partner-eyebrow">Welcome back</p>
            <h1>Enter your partner PIN</h1>
            <p className="partner-card-copy">Sign in to see the notes that currently need an emergency unlock.</p>
            <form className="partner-form" onSubmit={submitLogin} data-testid="partner-login-form">
              <PinField
                id="partner-login-pin"
                label="Six-digit PIN"
                value={loginPin}
                onChange={setLoginPin}
                testId="partner-login-pin"
                autoComplete="current-password"
                autoFocus
              />
              <button
                type="submit"
                className="partner-button is-full"
                disabled={isBusy || rateLimited}
                data-testid="partner-login-submit"
              >
                {isBusy ? 'Signing in…' : 'Continue'}
              </button>
            </form>
          </section>
        ) : null}

        {screen === 'dashboard' ? (
          <section className="partner-dashboard">
            <div className="partner-dashboard-header">
              <div>
                <p className="partner-eyebrow">Emergency unlocks</p>
                <h1>Locked notes</h1>
                <p>You can unlock a note for its owner. Note contents are never shown here.</p>
              </div>
              <div className="partner-header-actions">
                <button
                  type="button"
                  className="partner-button is-secondary is-compact"
                  onClick={openSettings}
                  data-testid="partner-settings-open"
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="partner-button is-quiet is-compact"
                  onClick={() => void signOut()}
                  disabled={isBusy}
                  data-testid="partner-logout"
                >
                  Sign out
                </button>
              </div>
            </div>

            {notesLoading ? (
              <div className="partner-list-state" aria-busy="true">
                <div className="partner-spinner" aria-hidden="true" />
                <span>Loading locked notes…</span>
              </div>
            ) : notes.length === 0 ? (
              <div className="partner-list-state" data-testid="partner-notes-empty">
                <div className="partner-state-icon is-success" aria-hidden="true">✓</div>
                <h2>No locked notes need help</h2>
                <p>This list refreshes automatically while the page is open.</p>
              </div>
            ) : (
              <ul className="partner-note-list" data-testid="partner-note-list">
                {notes.map((note) => (
                  <li className="partner-note-card" key={note.id} data-note-id={note.id}>
                    <div className="partner-note-icon"><LockMark /></div>
                    <div className="partner-note-details">
                      <h2>{note.title}</h2>
                      <div className="partner-note-meta">
                        <span>{formatLockKind(note.lockKind)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatLockedUntil(note)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="partner-button is-compact"
                      onClick={() => setPendingUnlock(note)}
                      data-testid={`partner-unlock-${note.id}`}
                      aria-label={`Unlock ${note.title}`}
                    >
                      Unlock
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              className="partner-refresh-button"
              onClick={() => void loadNotes(false)}
              disabled={notesLoading}
              data-testid="partner-notes-refresh"
            >
              Refresh notes
            </button>
          </section>
        ) : null}

        {screen === 'settings' ? (
          <section className="partner-card">
            <button
              type="button"
              className="partner-back-button"
              onClick={() => {
                setError('');
                setScreen('dashboard');
              }}
            >
              <span aria-hidden="true">←</span> Locked notes
            </button>
            <p className="partner-eyebrow">Settings</p>
            <h1>Change your PIN</h1>
            <p className="partner-card-copy">
              Changing your PIN signs out other partner sessions. This browser stays signed in.
            </p>
            <form className="partner-form" onSubmit={submitPinChange} data-testid="partner-settings-form">
              <PinField
                id="partner-current-pin"
                label="Current PIN"
                value={currentPin}
                onChange={setCurrentPin}
                testId="partner-current-pin"
                autoComplete="current-password"
                autoFocus
              />
              <PinField
                id="partner-new-pin"
                label="New six-digit PIN"
                value={newPin}
                onChange={setNewPin}
                testId="partner-new-pin"
                autoComplete="new-password"
              />
              <PinField
                id="partner-new-pin-confirm"
                label="Confirm new PIN"
                value={newPinConfirmation}
                onChange={setNewPinConfirmation}
                testId="partner-new-pin-confirm"
                autoComplete="new-password"
              />
              <button
                type="submit"
                className="partner-button is-full"
                disabled={isBusy || rateLimited}
                data-testid="partner-settings-submit"
              >
                {isBusy ? 'Changing PIN…' : 'Change PIN'}
              </button>
            </form>
          </section>
        ) : null}
      </main>

      {pendingUnlock ? (
        <UnlockConfirmation
          note={pendingUnlock}
          isBusy={unlockingId === pendingUnlock.id}
          onCancel={() => setPendingUnlock(null)}
          onConfirm={() => void confirmUnlock()}
        />
      ) : null}
    </div>
  );
}
