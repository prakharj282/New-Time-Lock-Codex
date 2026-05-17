import { useState } from 'react';
import { calculateFutureTimestamp, calculateTimestampForDateTime } from '../utils/time';
import type { NoteSchedule, ScheduleSlot } from '../utils/storage';
import { ALWAYS_LOCKED_UNTIL } from '../utils/storage';

type LockMode = 'duration' | 'datetime' | 'schedule' | 'always';

interface LockResult {
    lockedUntil?: number;
    emergencyLength: number;
    hideTypos: boolean;
    schedule?: NoteSchedule;
}

interface LockModalProps {
    onLock: (result: LockResult) => void;
    onCancel: () => void;
    currentSchedule?: NoteSchedule;
}

const DAY_LABELS = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' },
];

function initPerDay(currentSchedule?: NoteSchedule): Record<number, ScheduleSlot[]> {
    if (currentSchedule?.perDay) {
        const result: Record<number, ScheduleSlot[]> = {};
        for (const [key, slots] of Object.entries(currentSchedule.perDay)) {
            result[Number(key)] = slots.map(s => ({ ...s }));
        }
        return result;
    }
    if (currentSchedule?.days && currentSchedule.days.length > 0 && currentSchedule.slots) {
        const result: Record<number, ScheduleSlot[]> = {};
        for (const day of currentSchedule.days) {
            result[day] = currentSchedule.slots.map(s => ({ ...s }));
        }
        return result;
    }
    return {};
}

export function LockModal({ onLock, onCancel, currentSchedule }: LockModalProps) {
    const [mode, setMode] = useState<LockMode>(
        currentSchedule?.enabled ? 'schedule' : 'duration'
    );

    const [hours, setHours] = useState('2');
    const [minutes, setMinutes] = useState('0');

    const getDefaultDateTime = () => {
        const d = new Date();
        d.setHours(d.getHours() + 1, 0, 0, 0);
        return d.toISOString().slice(0, 16);
    };
    const [scheduledDateTime, setScheduledDateTime] = useState(getDefaultDateTime());

    const [perDay, setPerDay] = useState<Record<number, ScheduleSlot[]>>(
        initPerDay(currentSchedule)
    );
    const [selectedDay, setSelectedDay] = useState<number | null>(() => {
        const init = initPerDay(currentSchedule);
        const activeDays = DAY_LABELS.map(d => d.value).filter(v => init[v] && init[v].length > 0);
        return activeDays.length > 0 ? activeDays[0] : null;
    });

    const [emergencyLength, setEmergencyLength] = useState<number>(50);
    const [hideTypos, setHideTypos] = useState(false);

    const activeDays = DAY_LABELS.map(d => d.value).filter(v => perDay[v] && perDay[v].length > 0);

    const handleDayClick = (dayValue: number) => {
        if (perDay[dayValue] && perDay[dayValue].length > 0) {
            if (selectedDay === dayValue) {
                const updated = { ...perDay };
                delete updated[dayValue];
                setPerDay(updated);
                const remaining = DAY_LABELS.map(d => d.value).filter(v => updated[v] && updated[v].length > 0);
                setSelectedDay(remaining.length > 0 ? remaining[0] : null);
            } else {
                setSelectedDay(dayValue);
            }
        } else {
            const updated = { ...perDay, [dayValue]: [{ start: '09:00', end: '17:00' }] };
            setPerDay(updated);
            setSelectedDay(dayValue);
        }
    };

    const currentSlots = selectedDay !== null && perDay[selectedDay] ? perDay[selectedDay] : [];

    const addSlot = () => {
        if (selectedDay === null) return;
        if (currentSlots.length >= 5) return;
        setPerDay({
            ...perDay,
            [selectedDay]: [...currentSlots, { start: '09:00', end: '17:00' }],
        });
    };

    const removeSlot = (index: number) => {
        if (selectedDay === null) return;
        const updated = currentSlots.filter((_, i) => i !== index);
        if (updated.length === 0) {
            const newPerDay = { ...perDay };
            delete newPerDay[selectedDay];
            setPerDay(newPerDay);
            const remaining = DAY_LABELS.map(d => d.value).filter(v => newPerDay[v] && newPerDay[v].length > 0);
            setSelectedDay(remaining.length > 0 ? remaining[0] : null);
        } else {
            setPerDay({ ...perDay, [selectedDay]: updated });
        }
    };

    const updateSlot = (index: number, field: 'start' | 'end', value: string) => {
        if (selectedDay === null) return;
        const updated = [...currentSlots];
        updated[index] = { ...updated[index], [field]: value };
        setPerDay({ ...perDay, [selectedDay]: updated });
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (mode === 'duration') {
            const ts = calculateFutureTimestamp(parseInt(hours) || 0, parseInt(minutes) || 0);
            if (ts <= Date.now()) {
                alert('Please enter a valid duration.');
                return;
            }
            onLock({
                lockedUntil: ts,
                emergencyLength,
                hideTypos,
                schedule: { enabled: false, days: [], slots: [] },
            });
        } else if (mode === 'datetime') {
            const ts = calculateTimestampForDateTime(scheduledDateTime);
            if (ts <= Date.now()) {
                alert('Target time must be in the future!');
                return;
            }
            onLock({
                lockedUntil: ts,
                emergencyLength,
                hideTypos,
                schedule: { enabled: false, days: [], slots: [] },
            });
        } else if (mode === 'always') {
            onLock({
                lockedUntil: ALWAYS_LOCKED_UNTIL,
                emergencyLength,
                hideTypos,
                schedule: { enabled: false, days: [], slots: [] },
            });
        } else {
            if (activeDays.length === 0) {
                alert('Select at least one day.');
                return;
            }
            const allDays = Object.keys(perDay).map(Number);
            onLock({
                emergencyLength,
                hideTypos,
                schedule: {
                    enabled: true,
                    days: allDays,
                    slots: perDay[allDays[0]] || [],
                    perDay,
                },
            });
        }
    };

    const gibberishPercent = Math.min(100, (emergencyLength / 500) * 100);
    const gibberishColor = emergencyLength > 200
        ? 'var(--danger-color)'
        : emergencyLength > 100
            ? 'var(--warning-color)'
            : 'var(--accent-color)';

    return (
        <div className="fullpage-view">
            <div className="fullpage-toolbar">
                <button onClick={onCancel} className="btn-back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div className="fullpage-toolbar-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    Configure Lock
                </div>
            </div>

            <div className="fullpage-content">
                <form onSubmit={handleSubmit}>
                    <div className="mode-tabs mode-tabs-4">
                        <button
                            type="button"
                            className={mode === 'duration' ? 'tab-active' : 'tab-inactive'}
                            onClick={() => setMode('duration')}
                        >
                            Duration
                        </button>
                        <button
                            type="button"
                            className={mode === 'datetime' ? 'tab-active' : 'tab-inactive'}
                            onClick={() => setMode('datetime')}
                        >
                            Date & Time
                        </button>
                        <button
                            type="button"
                            className={mode === 'schedule' ? 'tab-active' : 'tab-inactive'}
                            onClick={() => setMode('schedule')}
                        >
                            Schedule
                        </button>
                        <button
                            type="button"
                            className={mode === 'always' ? 'tab-active' : 'tab-inactive'}
                            onClick={() => setMode('always')}
                        >
                            Always
                        </button>
                    </div>

                    {mode === 'duration' && (
                        <>
                            <p className="modal-hint">Lock for a set amount of time.</p>
                            <div className="duration-inputs">
                                <div style={{ flex: 1 }}>
                                    <label>Hours</label>
                                    <input type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <label>Minutes</label>
                                    <input type="number" min="0" max="59" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                                </div>
                            </div>
                        </>
                    )}

                    {mode === 'datetime' && (
                        <>
                            <p className="modal-hint">Lock until a specific date and time.</p>
                            <div style={{ marginBottom: '20px' }}>
                                <input
                                    type="datetime-local"
                                    required
                                    value={scheduledDateTime}
                                    onChange={(e) => setScheduledDateTime(e.target.value)}
                                    style={{ width: '100%' }}
                                />
                            </div>
                        </>
                    )}

                    {mode === 'schedule' && (
                        <div className="schedule-config-body" style={{ marginBottom: '20px' }}>
                            <p className="modal-hint">
                                Tap a day to add it. Tap again to switch to it. Tap the selected day again to remove it.
                            </p>

                            <div className="day-picker">
                                <label className="day-picker-label">Days</label>
                                <div className="day-picker-row">
                                    {DAY_LABELS.map(({ value, label }) => {
                                        const isActive = perDay[value] && perDay[value].length > 0;
                                        const isSelected = selectedDay === value;
                                        return (
                                            <button
                                                key={value}
                                                type="button"
                                                className={`day-btn ${isActive ? 'day-btn-active' : ''} ${isSelected ? 'day-btn-selected' : ''}`}
                                                onClick={() => handleDayClick(value)}
                                            >
                                                {label}
                                                {isActive && <span className="day-btn-dot" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {selectedDay !== null && (
                                <div className="slots-section">
                                    <label className="day-picker-label">
                                        {DAY_LABELS.find(d => d.value === selectedDay)?.label} Time Slots
                                    </label>
                                    {currentSlots.map((slot, idx) => (
                                        <div className="slot-row" key={idx}>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]{2}:[0-9]{2}"
                                                placeholder="HH:MM"
                                                value={slot.start}
                                                onChange={(e) => {
                                                    let v = e.target.value.replace(/[^0-9:]/g, '');
                                                    if (v.length === 2 && !v.includes(':') && slot.start.length < 3) v += ':';
                                                    if (v.length <= 5) updateSlot(idx, 'start', v);
                                                }}
                                                onBlur={(e) => {
                                                    const m = e.target.value.match(/^(\d{1,2}):(\d{2})$/);
                                                    if (m) {
                                                        const h = Math.min(23, parseInt(m[1]));
                                                        const min = Math.min(59, parseInt(m[2]));
                                                        updateSlot(idx, 'start', `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`);
                                                    }
                                                }}
                                                className="slot-time-input"
                                            />
                                            <span className="slot-separator">&rarr;</span>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]{2}:[0-9]{2}"
                                                placeholder="HH:MM"
                                                value={slot.end}
                                                onChange={(e) => {
                                                    let v = e.target.value.replace(/[^0-9:]/g, '');
                                                    if (v.length === 2 && !v.includes(':') && slot.end.length < 3) v += ':';
                                                    if (v.length <= 5) updateSlot(idx, 'end', v);
                                                }}
                                                onBlur={(e) => {
                                                    const m = e.target.value.match(/^(\d{1,2}):(\d{2})$/);
                                                    if (m) {
                                                        const h = Math.min(23, parseInt(m[1]));
                                                        const min = Math.min(59, parseInt(m[2]));
                                                        updateSlot(idx, 'end', `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`);
                                                    }
                                                }}
                                                className="slot-time-input"
                                            />
                                            {currentSlots.length > 1 && (
                                                <button
                                                    type="button"
                                                    className="btn-remove-slot"
                                                    onClick={() => removeSlot(idx)}
                                                    title="Remove slot"
                                                >
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                    {currentSlots.length < 5 && (
                                        <button type="button" className="btn-add-slot" onClick={addSlot}>
                                            + Add Time Slot
                                        </button>
                                    )}
                                </div>
                            )}

                            {selectedDay === null && activeDays.length === 0 && (
                                <p className="modal-hint" style={{ textAlign: 'center', marginTop: '16px', opacity: 0.6 }}>
                                    Tap a day above to start configuring its schedule.
                                </p>
                            )}
                        </div>
                    )}

                    {mode === 'always' && (
                        <div style={{ marginBottom: '20px', padding: '20px', background: 'var(--bg-tertiary)', borderRadius: '12px', textAlign: 'center' }}>
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger-color)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '12px' }}>
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                            </svg>
                            <p className="modal-hint" style={{ fontSize: '15px', marginBottom: '8px' }}>
                                This note will be <b style={{ color: 'var(--danger-color)' }}>permanently locked</b>.
                            </p>
                            <p className="modal-hint" style={{ opacity: 0.7 }}>
                                It can only be unlocked by typing the emergency gibberish password{' '}
                                or using an Emergency Open credit.
                            </p>
                        </div>
                    )}

                    <div className="gibberish-section">
                        <label className="gibberish-label">
                            Emergency Password Length
                        </label>
                        <input
                            type="number"
                            min="20"
                            max="10000"
                            value={emergencyLength}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                if (!isNaN(val)) setEmergencyLength(val);
                            }}
                            style={{ width: '100%', marginBottom: '6px' }}
                            placeholder="Enter number of characters"
                        />
                        <div className="gibberish-bar">
                            <div
                                className="gibberish-bar-fill"
                                style={{
                                    width: `${gibberishPercent}%`,
                                    background: emergencyLength > 200
                                        ? 'linear-gradient(90deg, var(--warning-color), var(--danger-color))'
                                        : emergencyLength > 100
                                            ? 'linear-gradient(90deg, var(--accent-color), var(--warning-color))'
                                            : 'var(--accent-color)'
                                }}
                            />
                        </div>
                        <div className="gibberish-value" style={{ color: gibberishColor }}>
                            {emergencyLength} characters to break this lock
                        </div>
                    </div>

                    <div className="hide-typos-section">
                        <div>
                            <div className="hide-typos-label">Hide Typo Feedback</div>
                            <div className="hide-typos-desc">
                                {hideTypos
                                    ? 'Hard mode: No green/red hints during emergency unlock'
                                    : 'Normal: Characters highlight green (correct) or red (wrong)'}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => setHideTypos(!hideTypos)}
                            className={`toggle-btn ${hideTypos ? 'toggle-on-danger' : ''}`}
                        >
                            {hideTypos ? 'ON' : 'OFF'}
                        </button>
                    </div>

                    <div className="fullpage-actions">
                        <button type="submit" className="btn-extend" style={{ flex: 1 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            {mode === 'schedule' ? 'Set Schedule' : mode === 'always' ? 'Lock Forever' : 'Apply Lock'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
