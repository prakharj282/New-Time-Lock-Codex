import { useEffect, useState } from 'react';
import type { AppNote } from '../App';
import { formatUnlockTime } from '../utils/time';
import { isWithinSchedule, getNoteContent, isAlwaysLocked, getScheduleState, getNextScheduleEvent } from '../utils/storage';

interface NoteCardProps {
    note: AppNote;
    onClick: () => void;
    index: number;
}

function formatDiff(ms: number): string {
    if (ms <= 0) return '0s';
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}

export function NoteCard({ note, onClick, index }: NoteCardProps) {
    const [timeLeft, setTimeLeft] = useState<string>('');
    const [scheduleCountdown, setScheduleCountdown] = useState<string>('');
    const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);

    useEffect(() => {
        let stale = false;
        const locked = note.lockedUntil && note.lockedUntil > Date.now();
        if (locked) {
            setThumbnailSrc(null);
            return;
        }
        getNoteContent(note.id).then(content => {
            if (stale) return;
            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.type === 'image' && typeof parsed.data === 'string') {
                    setThumbnailSrc(parsed.data);
                } else {
                    setThumbnailSrc(null);
                }
            } catch {
                setThumbnailSrc(null);
            }
        }).catch(() => {
            if (!stale) setThumbnailSrc(null);
        });
        return () => { stale = true; };
    }, [note.id, note.lockedUntil]);

    const isLocked = note.lockedUntil && note.lockedUntil > Date.now();
    const alwaysLocked = isAlwaysLocked(note);
    const hasSchedule = note.schedule?.enabled;
    const isScheduleActive = hasSchedule && isWithinSchedule(note.schedule!);
    const schedulePhase = hasSchedule ? getScheduleState(note.schedule!) : null;

    useEffect(() => {
        if (!isLocked || alwaysLocked) return;

        const interval = setInterval(() => {
            const now = Date.now();
            const diff = (note.lockedUntil || 0) - now;

            if (diff <= 0) {
                setTimeLeft('');
                clearInterval(interval);
            } else {
                setTimeLeft(formatDiff(diff));
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [note.lockedUntil, isLocked, alwaysLocked]);

    const scheduleKey = hasSchedule ? JSON.stringify(note.schedule) : '';
    useEffect(() => {
        if (!hasSchedule || isLocked) { setScheduleCountdown(''); return; }
        const update = () => {
            const evt = getNextScheduleEvent(note.schedule!);
            if (evt) {
                setScheduleCountdown(formatDiff(evt.timeMs));
            } else {
                setScheduleCountdown('');
            }
        };
        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [scheduleKey, isLocked, hasSchedule]);

    const weekStartMs = (() => {
        const now = new Date();
        const day = now.getDay();
        const daysSinceMonday = day === 0 ? 6 : day - 1;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - daysSinceMonday);
        weekStart.setHours(0, 0, 0, 0);
        return weekStart.getTime();
    })();

    const eoLog = note.emergencyOpenLog || [];
    const eoUsedThisWeek = eoLog.filter(t => t >= weekStartMs).length;
    const eoLimit = note.emergencyOpenPerWeek || 0;
    const eoQuotaLeft = eoLimit - eoUsedThisWeek;

    const accentClass = isScheduleActive ? 'scheduled' : isLocked ? 'locked' : hasSchedule ? (schedulePhase === 'off-today' ? 'schedule-off' : 'schedule-break') : 'unlocked';

    return (
        <div
            className="card note-card note-card-detailed"
            onClick={onClick}
            style={{ animationDelay: `${index * 60}ms`, animation: `fadeInUp 0.4s ease ${index * 60}ms both` }}
        >
            <div className={`note-card-accent ${accentClass}`} />
            {thumbnailSrc && (
                <div className="note-card-thumbnail">
                    <img src={thumbnailSrc} alt="" />
                </div>
            )}
            <div className="note-card-body">
                <div className="note-card-header">{note.title}</div>
                <div className="note-card-info">
                    <div className="note-card-info-row">
                        {isLocked
                            ? <>
                                <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke={isScheduleActive ? 'var(--scheduled-color)' : 'var(--locked-color)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                </svg>
                                <span className={isScheduleActive ? 'scheduled-text' : 'locked-text'}>
                                    {alwaysLocked ? 'Always Locked' : isScheduleActive ? `Schedule · Locked (${timeLeft})` : `Locked (${timeLeft})`}
                                </span>
                              </>
                            : hasSchedule ? <>
                                <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke={schedulePhase === 'break' ? 'var(--success-color)' : 'var(--text-secondary)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                    <line x1="8" y1="2" x2="8" y2="6"/>
                                    <line x1="3" y1="10" x2="21" y2="10"/>
                                </svg>
                                <span className={schedulePhase === 'break' ? 'schedule-break-text' : 'schedule-off-text-card'}>
                                    {schedulePhase === 'break' ? 'Schedule · Open' : 'Schedule · Off Today'}
                                </span>
                              </>
                            : <>
                                <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke="var(--unlocked-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                    <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                                </svg>
                                <span className="unlocked-text">Unlocked</span>
                              </>
                        }
                    </div>

                    {isLocked && !alwaysLocked && !isScheduleActive && (
                        <div className="note-card-info-row">
                            <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            Opens: {formatUnlockTime(note.lockedUntil!)}
                        </div>
                    )}

                    {hasSchedule && !isLocked && schedulePhase === 'break' && scheduleCountdown && (
                        <div className="note-card-info-row">
                            <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            <span style={{ color: 'var(--warning-color)' }}>Locks in {scheduleCountdown}</span>
                        </div>
                    )}

                    {note.emergencyLength != null && note.emergencyLength > 0 && (
                        <div className="note-card-info-row">
                            <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                            </svg>
                            {note.emergencyLength} gibberish chars
                        </div>
                    )}

                    {note.emergencyOpenEnabled && (
                        <div className="note-card-info-row">
                            <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke="var(--purple-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                            </svg>
                            Emergency: {eoUsedThisWeek}/{eoLimit} used
                            {eoQuotaLeft > 0
                                ? <span style={{ color: 'var(--success-color)' }}> ({eoQuotaLeft} left)</span>
                                : <span style={{ color: 'var(--danger-color)' }}> (exhausted)</span>
                            }
                        </div>
                    )}

                    {note.hideTypos && (
                        <div className="note-card-info-row">
                            <svg className="note-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                                <line x1="1" y1="1" x2="23" y2="23"/>
                            </svg>
                            Typos hidden
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
