import { useState, useEffect } from 'react';
import { generateGibberish } from '../utils/gibberish';

interface EmergencyUnlockModalProps {
    requiredLength: number;
    hideTypos: boolean;
    onSuccess: () => void;
    onCancel: () => void;
}

export function EmergencyUnlockModal({ requiredLength, hideTypos, onSuccess, onCancel }: EmergencyUnlockModalProps) {
    const [targetText, setTargetText] = useState('');
    const [inputText, setInputText] = useState('');

    useEffect(() => {
        setTargetText(generateGibberish(requiredLength));
    }, [requiredLength]);

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newVal = e.target.value;

        if (newVal.length - inputText.length > 3) {
            alert("No cheating! You must type this out manually.");
            return;
        }

        setInputText(newVal);
    };

    const preventDrop = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const preventCopyPaste = (e: React.ClipboardEvent) => {
        e.preventDefault();
    };

    const renderTargetText = () => {
        const chars = [];
        for (let i = 0; i < targetText.length; i++) {
            let color = 'var(--text-primary)';
            if (!hideTypos && i < inputText.length) {
                if (targetText[i] === inputText[i]) {
                    color = '#34d399';
                } else {
                    color = '#ef4444';
                }
            }
            chars.push(
                <span key={i} style={{ color }}>
                    {targetText[i]}
                </span>
            );
        }
        return chars;
    };

    const isMatched = inputText === targetText;
    const progressPercent = targetText.length > 0 ? (inputText.length / targetText.length) * 100 : 0;

    return (
        <div className="fullpage-view emergency-fullpage">
            <div className="fullpage-toolbar">
                <button onClick={onCancel} className="btn-back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div className="fullpage-toolbar-title emergency-toolbar-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    Emergency Unlock
                </div>
            </div>

            <div className="fullpage-content">
                <p className="emergency-description">
                    This note is locked. To access it before the timer expires, you must type the exact random characters below.
                    <br /><br />
                    <b>Anti-cheat active:</b> Copy/pasting is disabled.
                    {hideTypos && (
                        <>
                            <br />
                            <span style={{ color: 'var(--warning-color)' }}>&#9888; Hard mode: Typo feedback is hidden.</span>
                        </>
                    )}
                </p>

                <div
                    className="emergency-target-text"
                    onCopy={preventCopyPaste}
                >
                    {renderTargetText()}
                </div>

                <div className="emergency-progress">
                    <div className="emergency-progress-bar">
                        <div
                            className="emergency-progress-fill"
                            style={{ width: `${progressPercent}%` }}
                        />
                    </div>
                    <div className="emergency-progress-text">
                        {inputText.length} / {targetText.length} characters ({Math.round(progressPercent)}%)
                    </div>
                </div>

                <textarea
                    value={inputText}
                    onChange={handleInputChange}
                    onPaste={preventCopyPaste}
                    onDrop={preventDrop}
                    onCopy={preventCopyPaste}
                    onCut={preventCopyPaste}
                    placeholder="Start typing..."
                    rows={4}
                    className="emergency-textarea"
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                />

                <div className="fullpage-actions">
                    <button
                        type="button"
                        onClick={onSuccess}
                        disabled={!isMatched}
                        className={isMatched ? 'danger' : ''}
                        style={{
                            background: isMatched ? 'linear-gradient(135deg, #ef4444, #dc2626)' : 'var(--bg-tertiary)',
                            opacity: isMatched ? 1 : 0.5,
                            cursor: isMatched ? 'pointer' : 'not-allowed',
                            flex: 1
                        }}
                    >
                        {isMatched ? (
                            <>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                                Unlock Note
                            </>
                        ) : `${inputText.length} / ${targetText.length}`}
                    </button>
                </div>
            </div>
        </div>
    );
}
