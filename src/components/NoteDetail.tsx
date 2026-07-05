import { useState, useEffect, useRef } from 'react';
import type { AppNote } from '../App';
import { LockModal } from './LockModal';
import { EmergencyUnlockModal } from './EmergencyUnlockModal';
import { CanvasContentViewer } from './CanvasContentViewer';
import { formatUnlockTime } from '../utils/time';
import * as store from '../utils/storage';
import { compressPhotoFile } from '../utils/photo';
import { isWithinSchedule, getScheduleByDay, getScheduleState, getNextScheduleEvent, getActiveSlotForNow, getNextUpcomingSlot } from '../utils/storage';
import type { ScheduleEvent } from '../utils/storage';

function isImageContent(content: string): boolean {
    try {
        const parsed = JSON.parse(content);
        return parsed && parsed.type === 'image' && typeof parsed.data === 'string';
    } catch {
        return false;
    }
}

function getImageData(content: string): string | null {
    try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.type === 'image') return parsed.data;
    } catch {
        return null;
    }
    return null;
}

type ViewType = 'detail' | 'lock' | 'extendLock' | 'extendGibberish' | 'emergencyUnlock' | 'confirmDelete';

interface NoteDetailProps {
    note: AppNote;
    isUnsaved: boolean;
    onBack: (savedNote?: AppNote) => void;
    onNoteSaved?: (savedNote: AppNote) => void;
}

function getWeekStartMs(): number {
    const now = new Date();
    const day = now.getDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysSinceMonday);
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

export function NoteDetail({ note, isUnsaved, onBack, onNoteSaved }: NoteDetailProps) {
    const [title, setTitle] = useState(note.title);
    const [content, setContent] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [currentView, setCurrentView] = useState<ViewType>('detail');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const [localNote, setLocalNote] = useState<AppNote>(note);

    useEffect(() => {
        setLocalNote(prev => {
            const changes: Partial<AppNote> = {};
            if (note.lockedUntil !== prev.lockedUntil) changes.lockedUntil = note.lockedUntil;
            if (note.title !== prev.title) { changes.title = note.title; setTitle(note.title); }
            if (JSON.stringify(note.schedule) !== JSON.stringify(prev.schedule)) changes.schedule = note.schedule;
            if (Object.keys(changes).length > 0) return { ...prev, ...changes };
            return prev;
        });
    }, [note.lockedUntil, note.title, JSON.stringify(note.schedule)]);

    useEffect(() => {
        const checkSchedule = async () => {
            if (localNote.schedule?.enabled && (!localNote.lockedUntil || localNote.lockedUntil <= Date.now())) {
                try {
                    const result = await store.applySchedules();
                    if (result.updated) {
                        const updated = result.notes.find(n => n.id === localNote.id);
                        if (updated && updated.lockedUntil && updated.lockedUntil > Date.now()) {
                            setLocalNote(prev => ({ ...prev, lockedUntil: updated.lockedUntil }));
                        }
                    }
                } catch (err) {
                    setError(store.getErrorMessage(err, 'Could not apply schedule lock.'));
                }
            }
        };
        checkSchedule();
        const interval = setInterval(checkSchedule, 10_000);
        return () => clearInterval(interval);
    }, [localNote.id, localNote.schedule?.enabled]);

    const [eoEnabled, setEoEnabled] = useState(note.emergencyOpenEnabled || false);
    const [eoPerWeek, setEoPerWeek] = useState(note.emergencyOpenPerWeek || 2);
    const isNewNote = isUnsaved && !note.restricted;
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setError('');
        try {
            const photo = await compressPhotoFile(file);
            const imageJson = JSON.stringify({ type: 'image', data: photo.dataUrl });
            setContent(imageJson);
            if (title === 'New Note' || title === '') {
                const now = new Date();
                setTitle(`Photo ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
            }
        } catch (err) {
            setError(store.getErrorMessage(err, 'Could not prepare photo. Please try a smaller image.'));
            e.target.value = '';
        }
    };

    const [extendMode, setExtendMode] = useState<'duration' | 'datetime'>('duration');
    const [extendHours, setExtendHours] = useState('1');
    const [extendMinutes, setExtendMinutes] = useState('0');
    const getDefaultExtendDateTime = () => {
        const d = new Date((localNote.lockedUntil || Date.now()) + 3600000);
        return d.toISOString().slice(0, 16);
    };
    const [extendDateTime, setExtendDateTime] = useState(getDefaultExtendDateTime());

    const currentGibberishLength = localNote.emergencyLength || 50;
    const [newGibberishLength, setNewGibberishLength] = useState(currentGibberishLength);

    const isLocked = !!localNote.lockedUntil && localNote.lockedUntil > Date.now();
    const alwaysLocked = store.isAlwaysLocked(localNote);
    const isScheduleLocked = isLocked && localNote.schedule?.enabled && isWithinSchedule(localNote.schedule);
    const schedulePhase = localNote.schedule?.enabled ? getScheduleState(localNote.schedule) : null;
    const activeSlot = localNote.schedule?.enabled ? getActiveSlotForNow(localNote.schedule) : null;

    const [countdown, setCountdown] = useState('');
    const [scheduleNextEvent, setScheduleNextEvent] = useState<ScheduleEvent | null>(null);
    const [scheduleCountdown, setScheduleCountdown] = useState('');

    useEffect(() => {
        if (!isLocked || alwaysLocked) return;
        const update = () => {
            const diff = (localNote.lockedUntil || 0) - Date.now();
            if (diff <= 0) { setCountdown('00:00:00'); return; }
            const d = Math.floor(diff / 86400000);
            const h = Math.floor((diff % 86400000) / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            setCountdown(d > 0 ? `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
        };
        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [localNote.lockedUntil, isLocked, alwaysLocked]);

    const detailScheduleKey = localNote.schedule?.enabled ? JSON.stringify(localNote.schedule) : '';
    useEffect(() => {
        if (!localNote.schedule?.enabled) { setScheduleNextEvent(null); setScheduleCountdown(''); return; }
        const update = () => {
            const evt = getNextScheduleEvent(localNote.schedule!);
            setScheduleNextEvent(evt);
            if (evt && evt.timeMs > 0) {
                const ms = evt.timeMs;
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                const s = Math.floor((ms % 60000) / 1000);
                setScheduleCountdown(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
            } else {
                setScheduleCountdown('');
            }
        };
        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [detailScheduleKey, isLocked]);

    const weekStartMs = getWeekStartMs();
    const eoLog = localNote.emergencyOpenLog || [];
    const eoUsedThisWeek = eoLog.filter(t => t >= weekStartMs).length;
    const eoLimit = localNote.emergencyOpenPerWeek || 0;
    const eoQuotaLeft = eoLimit - eoUsedThisWeek;

    useEffect(() => {
        let cancelled = false;

        const loadContent = async () => {
            setIsLoading(true);

            if (isUnsaved) {
                setContent(note.content || '');
                setIsLoading(false);
                return;
            }

            try {
                const decryptedContent = await store.getNoteContent(localNote.id);
                if (!cancelled) {
                    setContent(decryptedContent);
                    setError('');
                }
            } catch (err) {
                console.error('Failed to load note content:', err);
                if (!cancelled) {
                    setContent('');
                    setError(store.getErrorMessage(err, 'Failed to load note content.'));
                }
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadContent();
        return () => {
            cancelled = true;
        };
    }, [localNote.id, isUnsaved, note.content]);

    const handleSaveTitle = async () => {
        setIsSaving(true);
        setError('');
        try {
            const result = await store.updateTitle(localNote.id, title);
            if (result.success) {
                const savedNote = result.note || { ...localNote, title };
                setLocalNote(savedNote);
                onNoteSaved?.(savedNote);
            }
        } catch (err) {
            setError(store.getErrorMessage(err, 'Failed to save title.'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleSave = async (overrides?: Partial<AppNote>): Promise<boolean> => {
        const eoFields = isNewNote ? {
            emergencyOpenEnabled: eoEnabled,
            emergencyOpenPerWeek: eoEnabled ? eoPerWeek : 0,
            emergencyOpenLog: [],
        } : {};
        const restrictedField = isNewNote ? { restricted: true } : {};
        const updatedNote = { ...localNote, title, ...eoFields, ...restrictedField, ...overrides };
        setIsSaving(true);
        setError('');
        try {
            const result = await store.saveNote(updatedNote as AppNote, content);
            if (result.note) {
                setLocalNote(result.note);
            } else {
                setLocalNote(updatedNote as AppNote);
            }
            onBack(result.note || updatedNote as AppNote);
            return true;
        } catch (err) {
            setError(store.getErrorMessage(err, 'Failed to save note.'));
            return false;
        } finally {
            setIsSaving(false);
        }
    };

    const [deleteConfirmText, setDeleteConfirmText] = useState('');

    const handleDelete = async () => {
        setIsDeleting(true);
        setError('');
        try {
            await store.deleteNote(localNote.id);
            onBack();
        } catch (err) {
            setError(store.getErrorMessage(err, 'Failed to delete note.'));
            setCurrentView('detail');
        } finally {
            setIsDeleting(false);
        }
    };

    const executeLock = async (result: {
        lockedUntil?: number;
        emergencyLength: number;
        hideTypos: boolean;
        schedule?: AppNote['schedule'];
    }) => {
        setCurrentView('detail');
        const overrides: Partial<AppNote> = {
            emergencyLength: result.emergencyLength,
            hideTypos: result.hideTypos,
        };
        if (result.schedule?.enabled) {
            overrides.schedule = result.schedule;
            if (result.lockedUntil) {
                overrides.lockedUntil = result.lockedUntil;
            }
        } else {
            overrides.lockedUntil = result.lockedUntil!;
            overrides.schedule = { enabled: false, days: [], slots: [] };
        }
        await handleSave(overrides);
    };

    const executeEmergencyUnlock = async () => {
        setCurrentView('detail');
        setError('');
        try {
            const result = await store.emergencyUnlock(localNote.id);
            if (result.success && result.note) {
                setLocalNote(result.note);
                onBack(result.note);
            } else {
                setError(result.error || 'Failed to unlock note. Please try again.');
            }
        } catch (err) {
            setError(store.getErrorMessage(err, 'Failed to unlock note.'));
        }
    };

    const executeEmergencyOpen = async () => {
        if (!confirm('Use 1 Emergency Open to instantly unlock this note?')) return;
        setError('');
        try {
            const result = await store.useEmergencyOpen(localNote.id);
            if (result.success) {
                if (result.note) {
                    setLocalNote(result.note);
                } else {
                    setLocalNote({ ...localNote, lockedUntil: null, emergencyOpenLog: [...eoLog, Date.now()] });
                }
                onBack(result.note || { ...localNote, lockedUntil: null, emergencyOpenLog: [...eoLog, Date.now()] });
            } else if (result.error === 'quota_exhausted') {
                setError(`Quota exhausted! You've used all ${result.limit} Emergency Opens this week.`);
            } else {
                setError('Emergency Open failed: ' + result.error);
            }
        } catch (err) {
            setError(store.getErrorMessage(err, 'Emergency Open failed.'));
        }
    };

    const executeExtendLock = async () => {
        let newLockedUntil: number | false = false;
        if (extendMode === 'duration') {
            const addMs = ((parseInt(extendHours) || 0) * 60 * 60 * 1000) + ((parseInt(extendMinutes) || 0) * 60 * 1000);
            if (addMs <= 0) {
                alert('Please enter a valid extension time.');
                return;
            }
            try {
                newLockedUntil = await store.extendLock(localNote.id, addMs);
            } catch (err) {
                setError(store.getErrorMessage(err, 'Failed to extend lock.'));
                return;
            }
        } else {
            const targetTs = new Date(extendDateTime).getTime();
            if (targetTs <= Date.now()) {
                alert('Please select a date and time in the future.');
                return;
            }
            try {
                newLockedUntil = await store.setLockUntil(localNote.id, targetTs);
            } catch (err) {
                setError(store.getErrorMessage(err, 'Failed to set lock.'));
                return;
            }
        }
        if (newLockedUntil) {
            setLocalNote({ ...localNote, lockedUntil: newLockedUntil });
        }
        setCurrentView('detail');
        setExtendHours('1');
        setExtendMinutes('0');
        setExtendMode('duration');
    };

    const executeExtendGibberish = async () => {
        if (newGibberishLength <= currentGibberishLength) {
            alert('New length must be greater than the current length.');
            return;
        }
        try {
            const result = await store.setEmergencyLength(localNote.id, newGibberishLength);
            if (result) {
                setLocalNote({ ...localNote, emergencyLength: result });
            }
            setCurrentView('detail');
        } catch (err) {
            setError(store.getErrorMessage(err, 'Failed to extend gibberish length.'));
        }
    };


    if (isLoading) return <div className="loading-spinner">Loading...</div>;

    if (currentView === 'lock') {
        return (
            <LockModal
                onLock={executeLock}
                onCancel={() => setCurrentView('detail')}
                currentSchedule={localNote.schedule}
            />
        );
    }

    if (currentView === 'emergencyUnlock') {
        return (
            <EmergencyUnlockModal
                requiredLength={localNote.emergencyLength || 50}
                hideTypos={localNote.hideTypos || false}
                onSuccess={executeEmergencyUnlock}
                onCancel={() => setCurrentView('detail')}
            />
        );
    }

    if (currentView === 'extendLock') {
        return (
            <div className="fullpage-view">
                <div className="fullpage-toolbar">
                    <button onClick={() => setCurrentView('detail')} className="btn-back">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                        Back
                    </button>
                    <div className="fullpage-toolbar-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Extend Lock
                    </div>
                </div>

                <div className="fullpage-content">
                    <div className="mode-tabs">
                        <button
                            type="button"
                            className={extendMode === 'duration' ? 'tab-active' : 'tab-inactive'}
                            onClick={() => setExtendMode('duration')}
                            data-testid="extend-mode-duration"
                        >
                            Add Duration
                        </button>
                        <button
                            type="button"
                            className={extendMode === 'datetime' ? 'tab-active' : 'tab-inactive'}
                            onClick={() => { setExtendMode('datetime'); setExtendDateTime(getDefaultExtendDateTime()); }}
                            data-testid="extend-mode-datetime"
                        >
                            Set Date & Time
                        </button>
                    </div>

                    {extendMode === 'duration' ? (
                        <>
                            <p className="modal-hint">Add more time to the current lock.</p>
                            <div className="duration-inputs">
                                <div style={{ flex: 1 }}>
                                    <label>Hours</label>
                                    <input type="number" min="0" value={extendHours} onChange={(e) => setExtendHours(e.target.value)} data-testid="extend-hours" />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <label>Minutes</label>
                                    <input type="number" min="0" max="59" value={extendMinutes} onChange={(e) => setExtendMinutes(e.target.value)} data-testid="extend-minutes" />
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="modal-hint">Set a new unlock date and time.</p>
                            <div style={{ marginBottom: '20px' }}>
                                <input
                                    type="datetime-local"
                                    value={extendDateTime}
                                    onChange={(e) => setExtendDateTime(e.target.value)}
                                    style={{ width: '100%' }}
                                    data-testid="extend-datetime"
                                />
                            </div>
                        </>
                    )}

                    <div className="fullpage-actions">
                        <button type="button" onClick={executeExtendLock} className="btn-extend" style={{ flex: 1 }} data-testid="extend-lock-submit">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            Extend
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (currentView === 'extendGibberish') {
        return (
            <div className="fullpage-view">
                <div className="fullpage-toolbar">
                    <button onClick={() => setCurrentView('detail')} className="btn-back">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                        Back
                    </button>
                    <div className="fullpage-toolbar-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                        Extend Gibberish
                    </div>
                </div>

                <div className="fullpage-content">
                    <p className="modal-hint">
                        Increase the gibberish text length required to break this lock.
                        Current: <b>{currentGibberishLength}</b> characters.
                    </p>
                    <input
                        type="number"
                        min={currentGibberishLength + 1}
                        max="10000"
                        value={newGibberishLength}
                        onChange={(e) => {
                            const val = parseInt(e.target.value);
                            if (!isNaN(val)) setNewGibberishLength(val);
                        }}
                        style={{ width: '100%', marginBottom: '10px' }}
                        placeholder="Enter number of characters"
                        data-testid="extend-gibberish-length"
                    />
                    <div className="gibberish-bar">
                        <div
                            className="gibberish-bar-fill"
                            style={{
                                width: `${Math.min(100, (newGibberishLength / 500) * 100)}%`,
                                background: newGibberishLength > 200
                                    ? 'linear-gradient(90deg, var(--warning-color), var(--danger-color))'
                                    : 'linear-gradient(90deg, var(--accent-color), var(--warning-color))'
                            }}
                        />
                    </div>
                    <div className="gibberish-value" style={{ color: newGibberishLength > 200 ? 'var(--danger-color)' : 'var(--warning-color)', marginBottom: '20px' }}>
                        {newGibberishLength} characters
                    </div>
                    <div className="fullpage-actions">
                        <button
                            type="button"
                            onClick={executeExtendGibberish}
                            className="btn-extend"
                            disabled={newGibberishLength <= currentGibberishLength}
                            style={{ flex: 1 }}
                            data-testid="extend-gibberish-submit"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                            Extend
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (currentView === 'confirmDelete') {
        const isDeleteConfirmed = deleteConfirmText.toLowerCase() === 'delete';
        return (
            <div className="fullpage-view">
                <div className="fullpage-toolbar">
                    <button onClick={() => setCurrentView('detail')} className="btn-back">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                        Back
                    </button>
                    <div className="fullpage-toolbar-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        Delete Note
                    </div>
                </div>

                <div className="fullpage-content">
                    <p className="modal-hint" style={{ marginBottom: '20px' }}>
                        To confirm deletion, type the word <b>delete</b> below
                    </p>
                    <input
                        type="text"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        onPaste={(e) => e.preventDefault()}
                        placeholder='Type "delete" to confirm'
                        data-testid="delete-confirm-input"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        style={{ marginBottom: '20px' }}
                    />
                    <div className="fullpage-actions">
                        <button
                            type="button"
                            onClick={handleDelete}
                            className="danger"
                            disabled={!isDeleteConfirmed || isDeleting}
                            data-testid="delete-confirm"
                            style={{ flex: 1 }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            {isDeleting ? 'Deleting...' : 'Confirm Delete'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="note-detail-card" style={{ position: 'relative' }}>
            <div className="note-detail-toolbar">
                <button onClick={() => onBack()} className="btn-back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div style={{ flex: 1 }} />
                <button className="danger" onClick={() => { setError(''); setDeleteConfirmText(''); setCurrentView('confirmDelete'); }} data-testid="delete-note">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    Delete
                </button>
                {isLocked ? (
                    <>
                        {!localNote.schedule?.enabled && !alwaysLocked && (
                            <button
                                onClick={() => setCurrentView('extendLock')}
                                className="btn-extend"
                                data-testid="extend-lock-open"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                Extend
                            </button>
                        )}
                        <button
                            onClick={() => { setNewGibberishLength(currentGibberishLength); setCurrentView('extendGibberish'); }}
                            className="btn-extend"
                            data-testid="extend-gibberish-open"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                            Gibberish
                        </button>
                        {localNote.emergencyOpenEnabled && eoQuotaLeft > 0 && (
                            <button
                                onClick={executeEmergencyOpen}
                                className="btn-emergency-open"
                                data-testid="emergency-open"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                Emergency
                            </button>
                        )}
                        <button className="danger" onClick={() => { setError(''); setCurrentView('emergencyUnlock'); }} data-testid="emergency-unlock-open">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                            Unlock
                        </button>
                    </>
                ) : (
                    <>
                        <button onClick={() => { setError(''); setCurrentView('lock'); }} data-testid="lock-note">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            Lock
                        </button>
                        <button onClick={() => handleSave()} className="btn-save" disabled={isSaving} data-testid="save-note">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                            {isSaving ? 'Saving...' : 'Save'}
                        </button>
                    </>
                )}
            </div>

            {error && (
                <div className="error-banner" data-testid="note-error" role="alert">
                    {error}
                </div>
            )}

            <div className="note-title-row">
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Note Title"
                    className="note-title-input"
                    data-testid="note-title-input"
                />
                {isLocked && title !== localNote.title && (
                    <button
                        className="btn-save-title"
                        onClick={handleSaveTitle}
                        disabled={isSaving}
                        data-testid="save-title"
                    >
                        {isSaving ? 'Saving...' : 'Save Title'}
                    </button>
                )}
            </div>

            {isLocked ? (
                <div className={`locked-content-panel${isScheduleLocked ? ' schedule-locked-panel' : ''}`}>
                    <span className="locked-panel-icon">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={isScheduleLocked ? 'var(--scheduled-color)' : 'var(--locked-color)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                    </span>
                    <div className="locked-panel-title">
                        {alwaysLocked ? 'Always Locked' : isScheduleLocked ? 'Schedule Locked' : 'Note is Locked'}
                    </div>
                    <p className="locked-message">
                        {alwaysLocked
                            ? 'This note is permanently locked. Use Emergency Unlock or Emergency Open to access it.'
                            : isScheduleLocked
                                ? `Currently in a scheduled lock window (${activeSlot ? activeSlot.start + ' – ' + activeSlot.end : ''}).`
                                : 'Content is hidden and encrypted until the timer expires.'}
                    </p>
                    {!alwaysLocked && (
                        <div className="countdown-display">
                            <div className="countdown-label">{isScheduleLocked ? 'Schedule opens in' : 'Unlocks in'}</div>
                            <div className="countdown-time">{countdown}</div>
                        </div>
                    )}
                    {!alwaysLocked && !isScheduleLocked && (
                        <p className="unlock-time-display">
                            Opens: <b>{formatUnlockTime(localNote.lockedUntil!)}</b>
                        </p>
                    )}
                    {localNote.emergencyOpenEnabled && (
                        <div className="emergency-open-info">
                            <span style={{ color: '#a78bfa' }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: '4px' }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                Emergency Opens:
                            </span>{' '}
                            <b>{eoUsedThisWeek} / {eoLimit}</b> used this week
                            {eoQuotaLeft > 0
                                ? <span style={{ color: 'var(--success-color)' }}> ({eoQuotaLeft} remaining)</span>
                                : <span style={{ color: 'var(--danger-color)' }}> (exhausted — resets Monday)</span>
                            }
                        </div>
                    )}
                    {isScheduleLocked && localNote.schedule && (() => {
                        const days = getScheduleByDay(localNote.schedule);
                        const today = new Date().getDay();
                        return (
                            <div className="schedule-card schedule-card-in-locked">
                                <div className="schedule-card-header">
                                    <div className="schedule-card-header-left">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--scheduled-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                                        <span>Weekly Schedule</span>
                                    </div>
                                    <span className="schedule-phase-pill schedule-phase-locked">Locked</span>
                                </div>
                                <table className="schedule-table">
                                    <thead>
                                        <tr>
                                            <th className="schedule-th-day">Day</th>
                                            <th className="schedule-th-time">Lock Windows</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {days.map(entry => {
                                            const isActiveRow = entry.dayIndex === today && activeSlot && entry.slots.some(s => s.start === activeSlot.start && s.end === activeSlot.end);
                                            return (
                                                <tr
                                                    key={entry.dayIndex}
                                                    className={`schedule-tr${entry.slots.length === 0 ? ' schedule-tr-off' : ''}${entry.dayIndex === today ? ' schedule-tr-today' : ''}${isActiveRow ? ' schedule-tr-active' : ''}`}
                                                >
                                                    <td className="schedule-td-day">
                                                        <div className="schedule-td-day-inner">
                                                            {entry.dayIndex === today && <span className="schedule-today-dot" />}
                                                            {entry.dayName}
                                                        </div>
                                                    </td>
                                                    <td className="schedule-td-time">
                                                        <div className="schedule-td-time-inner">
                                                            {entry.slots.length > 0
                                                                ? entry.slots.map((s, i) => {
                                                                    const isActive = entry.dayIndex === today && activeSlot && s.start === activeSlot.start && s.end === activeSlot.end;
                                                                    return <span key={i} className={`schedule-time-badge${isActive ? ' schedule-time-active' : ''}`}>{s.start} – {s.end}</span>;
                                                                  })
                                                                : <span className="schedule-off-text">—</span>
                                                            }
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        );
                    })()}
                </div>
            ) : localNote.restricted && isLocked ? (
                <>
                    {isImageContent(content) ? (
                        <div className="photo-note-display">
                            <img src={getImageData(content)!} alt="Photo note" className="photo-note-image" />
                        </div>
                    ) : (
                        <CanvasContentViewer content={content} />
                    )}
                    {localNote.schedule?.enabled && (() => {
                        const days = getScheduleByDay(localNote.schedule!);
                        const today = new Date().getDay();
                        const phase = schedulePhase;
                        const nextSlot = getNextUpcomingSlot(localNote.schedule!);
                        return (
                            <>
                                {phase === 'break' && scheduleNextEvent && (
                                    <div className="schedule-break-banner">
                                        <div className="schedule-break-banner-left">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                            <span>Schedule Break</span>
                                        </div>
                                        <div className="schedule-break-banner-countdown">
                                            Locks in <b>{scheduleCountdown}</b>
                                        </div>
                                    </div>
                                )}
                                {phase === 'off-today' && (
                                    <div className="schedule-off-banner">
                                        <div className="schedule-off-banner-left">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                                            <span>Off Today</span>
                                        </div>
                                        {scheduleNextEvent && (
                                            <div className="schedule-off-banner-next">
                                                Next: {scheduleNextEvent.dayName} {scheduleNextEvent.time}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div className="schedule-card">
                                    <div className="schedule-card-header">
                                        <div className="schedule-card-header-left">
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--scheduled-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                                            <span>Weekly Schedule</span>
                                        </div>
                                        <span className={`schedule-phase-pill ${phase === 'break' ? 'schedule-phase-break' : phase === 'off-today' ? 'schedule-phase-off' : 'schedule-phase-locked'}`}>
                                            {phase === 'break' ? 'Open' : phase === 'off-today' ? 'Off' : 'Active'}
                                        </span>
                                    </div>
                                    <table className="schedule-table">
                                        <thead>
                                            <tr>
                                                <th className="schedule-th-day">Day</th>
                                                <th className="schedule-th-time">Lock Windows</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {days.map(entry => {
                                                const isNextRow = nextSlot && entry.dayIndex === nextSlot.dayIndex && entry.slots.some(s => s.start === nextSlot.slot.start && s.end === nextSlot.slot.end);
                                                return (
                                                    <tr
                                                        key={entry.dayIndex}
                                                        className={`schedule-tr${entry.slots.length === 0 ? ' schedule-tr-off' : ''}${entry.dayIndex === today ? ' schedule-tr-today' : ''}${isNextRow ? ' schedule-tr-active' : ''}`}
                                                    >
                                                        <td className="schedule-td-day">
                                                            <div className="schedule-td-day-inner">
                                                                {entry.dayIndex === today && <span className="schedule-today-dot" />}
                                                                {entry.dayName}
                                                            </div>
                                                        </td>
                                                        <td className="schedule-td-time">
                                                            <div className="schedule-td-time-inner">
                                                                {entry.slots.length > 0
                                                                    ? entry.slots.map((s, i) => {
                                                                        const isNext = nextSlot && entry.dayIndex === nextSlot.dayIndex && s.start === nextSlot.slot.start && s.end === nextSlot.slot.end;
                                                                        return <span key={i} className={`schedule-time-badge${isNext ? ' schedule-time-next' : ''}`}>{s.start} – {s.end}</span>;
                                                                      })
                                                                    : <span className="schedule-off-text">—</span>
                                                                }
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        );
                    })()}
                </>
            ) : (
                <>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handlePhotoCapture}
                        style={{ display: 'none' }}
                        data-testid="photo-input"
                    />

                    {isImageContent(content) ? (
                        <div className="photo-note-display">
                            <img src={getImageData(content)!} alt="Photo note" className="photo-note-image" data-testid="photo-note-image" />
                            {isNewNote && (
                                <button
                                    type="button"
                                    className="btn-retake-photo"
                                    onClick={() => {
                                        if (fileInputRef.current) {
                                            fileInputRef.current.value = '';
                                            fileInputRef.current.click();
                                        }
                                    }}
                                    data-testid="photo-retake"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                    Retake Photo
                                </button>
                            )}
                        </div>
                    ) : (
                        <>
                            {isNewNote && (
                                <button
                                    type="button"
                                    className="btn-camera-capture"
                                    onClick={() => fileInputRef.current?.click()}
                                    data-testid="photo-capture"
                                >
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                    Take Photo
                                </button>
                            )}
                            <textarea
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                placeholder="Write your note here..."
                                rows={6}
                                disabled={isLocked}
                                data-testid="note-content-input"
                            />
                        </>
                    )}

                    {localNote.schedule?.enabled && (() => {
                        const days = getScheduleByDay(localNote.schedule!);
                        const today = new Date().getDay();
                        const phase = schedulePhase;
                        const nextSlot = getNextUpcomingSlot(localNote.schedule!);
                        return (
                            <>
                                {phase === 'break' && scheduleNextEvent && (
                                    <div className="schedule-break-banner">
                                        <div className="schedule-break-banner-left">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                            <span>Schedule Break</span>
                                        </div>
                                        <div className="schedule-break-banner-countdown">
                                            Locks in <b>{scheduleCountdown}</b>
                                        </div>
                                    </div>
                                )}
                                {phase === 'off-today' && (
                                    <div className="schedule-off-banner">
                                        <div className="schedule-off-banner-left">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                                            <span>Off Today</span>
                                        </div>
                                        {scheduleNextEvent && (
                                            <div className="schedule-off-banner-next">
                                                Next: {scheduleNextEvent.dayName} {scheduleNextEvent.time}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div className="schedule-card">
                                    <div className="schedule-card-header">
                                        <div className="schedule-card-header-left">
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--scheduled-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                                            <span>Weekly Schedule</span>
                                        </div>
                                        <span className={`schedule-phase-pill ${phase === 'break' ? 'schedule-phase-break' : phase === 'off-today' ? 'schedule-phase-off' : 'schedule-phase-locked'}`}>
                                            {phase === 'break' ? 'Open' : phase === 'off-today' ? 'Off' : 'Active'}
                                        </span>
                                    </div>

                                    <table className="schedule-table">
                                        <thead>
                                            <tr>
                                                <th className="schedule-th-day">Day</th>
                                                <th className="schedule-th-time">Lock Windows</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {days.map(entry => {
                                                const isNextRow = nextSlot && entry.dayIndex === nextSlot.dayIndex && entry.slots.some(s => s.start === nextSlot.slot.start && s.end === nextSlot.slot.end);
                                                return (
                                                    <tr
                                                        key={entry.dayIndex}
                                                        className={`schedule-tr${entry.slots.length === 0 ? ' schedule-tr-off' : ''}${entry.dayIndex === today ? ' schedule-tr-today' : ''}${isNextRow ? ' schedule-tr-active' : ''}`}
                                                    >
                                                        <td className="schedule-td-day">
                                                            <div className="schedule-td-day-inner">
                                                                {entry.dayIndex === today && <span className="schedule-today-dot" />}
                                                                {entry.dayName}
                                                            </div>
                                                        </td>
                                                        <td className="schedule-td-time">
                                                            <div className="schedule-td-time-inner">
                                                                {entry.slots.length > 0
                                                                    ? entry.slots.map((s, i) => {
                                                                        const isNext = nextSlot && entry.dayIndex === nextSlot.dayIndex && s.start === nextSlot.slot.start && s.end === nextSlot.slot.end;
                                                                        return <span key={i} className={`schedule-time-badge${isNext ? ' schedule-time-next' : ''}`}>{s.start} – {s.end}</span>;
                                                                      })
                                                                    : <span className="schedule-off-text">—</span>
                                                                }
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        );
                    })()}

                    {isNewNote && (
                        <div className="config-section eo-section">
                            <div className="config-header">
                                <div>
                                    <div className="config-title">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--purple-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                        Emergency Open
                                    </div>
                                    <div className="config-subtitle">
                                        Instant unlock without typing gibberish (limited per week). Cannot be changed after saving.
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setEoEnabled(!eoEnabled)}
                                    className={`toggle-btn ${eoEnabled ? 'toggle-on-purple' : ''}`}
                                    data-testid="emergency-open-toggle"
                                >
                                    {eoEnabled ? 'ON' : 'OFF'}
                                </button>
                            </div>
                            {eoEnabled && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' }}>
                                    <label style={{ fontSize: '14px' }}>Opens per week:</label>
                                    <select
                                        value={eoPerWeek}
                                        onChange={(e) => setEoPerWeek(parseInt(e.target.value))}
                                        className="select-input"
                                        data-testid="emergency-open-per-week"
                                    >
                                        {[1, 2, 3, 4, 5].map(n => (
                                            <option key={n} value={n}>{n}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                    )}

                    {!isNewNote && localNote.emergencyOpenEnabled && (
                        <div className="config-section eo-info-section">
                            <span style={{ color: '#a78bfa' }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: '4px' }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                Emergency Open enabled:
                            </span>{' '}
                            {localNote.emergencyOpenPerWeek} per week
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
