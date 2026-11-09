import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountabilityAccessState } from '../utils/accountability';
import {
  createAccountabilityAccess,
  getAccountabilityAccess,
  isAccountabilityApiError,
} from '../utils/accountability';
import '../accountability.css';

export interface PartnerAccessPanelProps {
  onClose: () => void;
}

const STATUS_LABELS: Record<AccountabilityAccessState, string> = {
  none: 'Not configured',
  awaiting_setup: 'Awaiting setup',
  active: 'Active',
};

function getManagementError(error: unknown): string {
  if (!isAccountabilityApiError(error)) return 'Something went wrong. Please try again.';
  if (error.code === 'network_error') return 'Could not reach the server. Check your connection and try again.';
  if (error.code === 'invalid_response') return 'The server returned an unexpected response. Please try again.';
  if (error.code === 'invalid_management_key') return 'That management key is incorrect.';
  return 'Could not load or create partner access. Please try again.';
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }

    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    textArea.remove();
    return copied;
  } catch {
    return false;
  }
}

export function PartnerAccessPanel({ onClose }: PartnerAccessPanelProps) {
  const [status, setStatus] = useState<AccountabilityAccessState | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [canReplace, setCanReplace] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [managementKey, setManagementKey] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isIssuingLink, setIsIssuingLink] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const isIssuingLinkRef = useRef(false);

  useEffect(() => {
    isIssuingLinkRef.current = isIssuingLink;
  }, [isIssuingLink]);

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setIsBusy(true);
    try {
      const access = await getAccountabilityAccess();
      if (isIssuingLinkRef.current && silent) return;
      setStatus(access.state);
      setCanReplace(access.canReplace);
      if (!silent) setError('');
    } catch (loadError) {
      if (!silent) setError(getManagementError(loadError));
    } finally {
      if (!silent) setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    void loadStatus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isIssuingLinkRef.current) return;
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [loadStatus, onClose]);

  useEffect(() => {
    if (status !== 'awaiting_setup') return;
    const poll = window.setInterval(() => void loadStatus(true), 5_000);
    return () => window.clearInterval(poll);
  }, [loadStatus, status]);

  const issueLink = async (key?: string) => {
    if (isIssuingLinkRef.current) return;
    isIssuingLinkRef.current = true;
    setIsBusy(true);
    setIsIssuingLink(true);
    setError('');
    setNotice('');
    try {
      const created = await createAccountabilityAccess(key);
      setStatus(created.state);
      setShareUrl(created.shareUrl);
      setShowReplace(false);
      setManagementKey('');
      const copied = await copyText(created.shareUrl);
      setNotice(copied
        ? 'New partner link copied. Send it directly to your accountability partner.'
        : 'New partner link created. Copy or share it before closing this panel.');
    } catch (issueError) {
      if (isAccountabilityApiError(issueError) && issueError.code === 'access_exists') {
        await loadStatus();
      } else {
        setError(getManagementError(issueError));
      }
    } finally {
      isIssuingLinkRef.current = false;
      setIsBusy(false);
      setIsIssuingLink(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    const copied = await copyText(shareUrl);
    setNotice(copied ? 'Partner link copied.' : 'Copy failed. Select and copy the link below.');
  };

  const shareLink = async () => {
    if (!shareUrl) return;
    if (!navigator.share) {
      await copyLink();
      return;
    }

    try {
      await navigator.share({
        title: 'TimeLock Notes partner access',
        text: 'Use this private link to help me unlock a TimeLock note in an emergency.',
        url: shareUrl,
      });
      setNotice('Share sheet opened.');
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return;
      setNotice('Sharing was not available. You can copy the link instead.');
    }
  };

  return (
    <div className="accountability-panel-backdrop" data-testid="partner-access-panel">
      <section
        ref={panelRef}
        className="accountability-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="partner-access-title"
      >
        <div className="accountability-panel-header">
          <div>
            <p className="accountability-eyebrow">Emergency access</p>
            <h2 id="partner-access-title">Partner Access</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="accountability-icon-button"
            onClick={onClose}
            disabled={isIssuingLink}
            aria-label="Close partner access"
            data-testid="partner-access-close"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <p className="accountability-panel-description">
          {status === 'active'
            ? 'Your partner has set their PIN. They can use the original invitation to sign in and unlock notes for you.'
            : 'Send your private invitation to your partner so they can set their own six-digit PIN.'}
        </p>

        <div className="accountability-status-row" aria-live="polite">
          <span>Status</span>
          <span
            className={`accountability-status accountability-status-${status ?? 'loading'}`}
            data-testid="partner-access-status"
          >
            {status === null ? 'Checking…' : STATUS_LABELS[status]}
          </span>
        </div>

        {error ? <div className="accountability-alert is-error" role="alert">{error}</div> : null}
        {notice ? <div className="accountability-alert is-success" role="status">{notice}</div> : null}

        {shareUrl ? (
          <div className="accountability-share-card">
            <label htmlFor="partner-share-url">Private partner link</label>
            <input
              id="partner-share-url"
              data-testid="partner-share-url"
              value={shareUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
            />
            <p>This link is shown only now. Send it before closing this panel.</p>
            <div className="accountability-button-row">
              <button
                type="button"
                className="accountability-button is-secondary"
                onClick={copyLink}
                data-testid="partner-access-copy"
              >
                Copy link
              </button>
              <button
                type="button"
                className="accountability-button"
                onClick={shareLink}
                data-testid="partner-access-share"
              >
                Share link
              </button>
            </div>
          </div>
        ) : null}

        {status === 'none' ? (
          <button
            type="button"
            className="accountability-button is-full"
            disabled={isBusy}
            onClick={() => void issueLink()}
            data-testid="partner-access-create"
          >
            {isBusy ? 'Creating…' : 'Create partner link'}
          </button>
        ) : null}

        {canReplace && status && status !== 'none' && !showReplace ? (
          <button
            type="button"
            className="accountability-button is-secondary is-full"
            disabled={isBusy}
            onClick={() => setShowReplace(true)}
          >
            Replace partner link
          </button>
        ) : null}

        {showReplace ? (
          <form className="accountability-share-card" onSubmit={(event) => {
            event.preventDefault();
            void issueLink(managementKey);
          }}>
            <p>Replacing the link disables the old link, signs out your partner, and requires them to set a new PIN.</p>
            <label htmlFor="partner-management-key">Partner management key</label>
            <input
              id="partner-management-key"
              type="password"
              autoComplete="off"
              value={managementKey}
              onChange={(event) => setManagementKey(event.target.value)}
              required
            />
            <div className="accountability-button-row">
              <button type="button" className="accountability-button is-secondary" disabled={isBusy} onClick={() => {
                setShowReplace(false);
                setManagementKey('');
              }}>Cancel</button>
              <button type="submit" className="accountability-button" disabled={isBusy || !managementKey}>
                {isBusy ? 'Replacing…' : 'Replace and create new link'}
              </button>
            </div>
          </form>
        ) : null}

      </section>
    </div>
  );
}
