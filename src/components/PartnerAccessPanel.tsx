import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountabilityAccessState } from '../utils/accountability';
import {
  createAccountabilityAccess,
  getAccountabilityAccess,
  isAccountabilityApiError,
  revokeAccountabilityAccess,
  rotateAccountabilityAccess,
} from '../utils/accountability';
import '../accountability.css';

export interface PartnerAccessPanelProps {
  onClose: () => void;
}

type ConfirmAction = 'rotate' | 'revoke' | null;

const STATUS_LABELS: Record<AccountabilityAccessState, string> = {
  none: 'Not configured',
  awaiting_setup: 'Awaiting setup',
  active: 'Active',
};

function getManagementError(error: unknown): string {
  if (!isAccountabilityApiError(error)) return 'Something went wrong. Please try again.';
  if (error.code === 'network_error') return 'Could not reach the server. Check your connection and try again.';
  if (error.code === 'invalid_response') return 'The server returned an unexpected response. Please try again.';
  return 'Partner access could not be updated. Please try again.';
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
  const [isBusy, setIsBusy] = useState(false);
  const [isIssuingLink, setIsIssuingLink] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const confirmCancelButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const isIssuingLinkRef = useRef(false);
  const confirmActionRef = useRef<ConfirmAction>(null);

  useEffect(() => {
    isIssuingLinkRef.current = isIssuingLink;
  }, [isIssuingLink]);

  useEffect(() => {
    confirmActionRef.current = confirmAction;
    if (confirmAction) confirmCancelButtonRef.current?.focus();
  }, [confirmAction]);

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setIsBusy(true);
    try {
      const access = await getAccountabilityAccess();
      setStatus(access.state);
      if (access.state === 'active') setShareUrl(null);
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
        if (confirmActionRef.current) {
          setConfirmAction(null);
        } else {
          onClose();
        }
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

  const issueLink = async (rotate: boolean) => {
    setIsBusy(true);
    setIsIssuingLink(true);
    setError('');
    setNotice('');
    setConfirmAction(null);
    try {
      const created = rotate
        ? await rotateAccountabilityAccess()
        : await createAccountabilityAccess();
      setStatus(created.state);
      setShareUrl(created.shareUrl);
      const copied = await copyText(created.shareUrl);
      setNotice(copied
        ? 'New partner link copied. Send it directly to your accountability partner.'
        : 'New partner link created. Copy or share it before closing this panel.');
    } catch (issueError) {
      setError(getManagementError(issueError));
    } finally {
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

  const revoke = async () => {
    setIsBusy(true);
    setError('');
    setNotice('');
    try {
      await revokeAccountabilityAccess();
      setStatus('none');
      setShareUrl(null);
      setConfirmAction(null);
      setNotice('Partner access revoked. Existing links and sessions no longer work.');
    } catch (revokeError) {
      setError(getManagementError(revokeError));
    } finally {
      setIsBusy(false);
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
          Your partner can use a private link and their own six-digit PIN to unlock a note for you.
          You cannot set or view their PIN.
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
            onClick={() => void issueLink(false)}
            data-testid="partner-access-create"
          >
            {isBusy ? 'Creating…' : 'Create partner link'}
          </button>
        ) : null}

        {status === 'awaiting_setup' || status === 'active' ? (
          <div className="accountability-management-actions">
            <button
              type="button"
              className="accountability-button is-secondary"
              disabled={isBusy}
              onClick={() => setConfirmAction('rotate')}
              data-testid="partner-access-rotate"
            >
              Replace link
            </button>
            <button
              type="button"
              className="accountability-button is-danger-quiet"
              disabled={isBusy}
              onClick={() => setConfirmAction('revoke')}
              data-testid="partner-access-revoke"
            >
              Revoke access
            </button>
          </div>
        ) : null}

        {confirmAction ? (
          <div
            className="accountability-confirm-box"
            role="alertdialog"
            aria-labelledby="partner-access-confirm-title"
            aria-describedby="partner-access-confirm-description"
          >
            <strong id="partner-access-confirm-title">
              {confirmAction === 'rotate' ? 'Replace partner access?' : 'Revoke partner access?'}
            </strong>
            <p id="partner-access-confirm-description">
              {confirmAction === 'rotate'
                ? 'The current link, PIN, and all signed-in partner sessions will stop working.'
                : 'The current link, PIN, and all signed-in partner sessions will be invalidated.'}
            </p>
            <div className="accountability-button-row">
              <button
                ref={confirmCancelButtonRef}
                type="button"
                className="accountability-button is-secondary"
                disabled={isBusy}
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="accountability-button is-danger"
                disabled={isBusy}
                onClick={() => confirmAction === 'rotate' ? void issueLink(true) : void revoke()}
                data-testid={`partner-access-${confirmAction}-confirm`}
              >
                {isBusy ? 'Working…' : confirmAction === 'rotate' ? 'Replace access' : 'Revoke access'}
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
