import { useState, useEffect, useCallback, useRef } from 'react';
import { NoteList } from './components/NoteList';
import { NoteDetail } from './components/NoteDetail';
import { PartnerAccessPanel } from './components/PartnerAccessPanel';
import * as store from './utils/storage';
import type { Note } from './utils/storage';
import './index.css';

export type AppNote = Note;

function App() {
  const [notes, setNotes] = useState<AppNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [unsavedNoteIds, setUnsavedNoteIds] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showPartnerAccess, setShowPartnerAccess] = useState(false);
  const [appError, setAppError] = useState('');
  const lastTapRef = useRef<number>(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsavedNoteIdsRef = useRef<Set<string>>(new Set());
  const notesRef = useRef<AppNote[]>([]);
  const activeNoteIdRef = useRef<string | null>(null);

  useEffect(() => {
    unsavedNoteIdsRef.current = unsavedNoteIds;
  }, [unsavedNoteIds]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    activeNoteIdRef.current = activeNoteId;
  }, [activeNoteId]);

  const hasScheduledNotes = useCallback(() => {
    return notesRef.current.some(note => note.schedule?.enabled);
  }, []);

  const mergeServerNotes = useCallback((serverNotes: AppNote[]) => {
    setNotes(prev => {
      const previousById = new Map(prev.map(note => [note.id, note]));
      const newestServerNotes = serverNotes.map(note => {
        const previous = previousById.get(note.id);
        if (previous?.updatedAt && note.updatedAt) {
          if (previous.updatedAt > note.updatedAt) return previous;
          if (previous.updatedAt === note.updatedAt && JSON.stringify(previous) === JSON.stringify(note)) {
            return previous;
          }
        }
        return note;
      });
      const locallyProtectedNotes = prev.filter(note => (
        unsavedNoteIdsRef.current.has(note.id) || note.id === activeNoteIdRef.current
      ));
      const serverNoteIds = new Set(newestServerNotes.map(note => note.id));
      const mergedNotes = locallyProtectedNotes.length === 0
        ? newestServerNotes
        : [
          ...newestServerNotes,
          ...locallyProtectedNotes.filter(note => !serverNoteIds.has(note.id)),
        ];

      if (mergedNotes.length === prev.length
        && mergedNotes.every((note, index) => note === prev[index])) {
        return prev;
      }
      return mergedNotes;
    });
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      const loadedNotes = await store.getNotes();
      mergeServerNotes(loadedNotes);
      setAppError('');
    } catch (err) {
      setAppError(store.getErrorMessage(err, 'Could not load notes. Check your API and database settings.'));
    }
  }, [mergeServerNotes]);

  useEffect(() => {
    loadNotes();
    store.fetchLastKnownTime();

    const timeInterval = setInterval(() => {
      store.saveLastKnownTime();
    }, 60_000);

    // Schedule enforcement — check every 30s
    const scheduleInterval = setInterval(async () => {
      if (!hasScheduledNotes()) return;
      try {
        const result = await store.applySchedules();
        if (result.updated) {
          mergeServerNotes(result.notes);
        }
      } catch (err) {
        setAppError(store.getErrorMessage(err, 'Could not apply schedules.'));
      }
    }, 30_000);

    // Also check schedules immediately
    const immediateSchedule = setTimeout(async () => {
      if (!hasScheduledNotes()) return;
      try {
        const result = await store.applySchedules();
        if (result.updated) {
          mergeServerNotes(result.notes);
        }
      } catch (err) {
        setAppError(store.getErrorMessage(err, 'Could not apply schedules.'));
      }
    }, 1000);

    return () => {
      clearInterval(timeInterval);
      clearInterval(scheduleInterval);
      clearTimeout(immediateSchedule);
    };
  }, [hasScheduledNotes, loadNotes, mergeServerNotes]);

  useEffect(() => {
    const refreshVisibleNotes = () => {
      if (document.visibilityState !== 'visible') return;
      void loadNotes();
    };

    const pollInterval = setInterval(refreshVisibleNotes, 3_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshVisibleNotes();
      }
    };

    window.addEventListener('focus', refreshVisibleNotes);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(pollInterval);
      window.removeEventListener('focus', refreshVisibleNotes);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadNotes]);

  // Re-run schedule checks when notes change
  useEffect(() => {
    if (notes.length === 0) return;
    if (!notes.some(note => note.schedule?.enabled)) return;
    (async () => {
      try {
        const result = await store.applySchedules();
        if (result.updated) {
          mergeServerNotes(result.notes);
        }
      } catch (err) {
        setAppError(store.getErrorMessage(err, 'Could not apply schedules.'));
      }
    })();
  }, [notes, mergeServerNotes]);

  const handleRefresh = async () => {
    const now = Date.now();
    if (now - lastTapRef.current < 400) {
      window.location.reload();
      return;
    }
    lastTapRef.current = now;

    if (isRefreshing) return;

    setIsRefreshing(true);
    try {
      await loadNotes();
      const result = await store.applySchedules();
      if (result.updated) {
        mergeServerNotes(result.notes);
      }
    } catch (err) {
      setAppError(store.getErrorMessage(err, 'Refresh failed.'));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRefreshPointerDown = () => {
    longPressTimerRef.current = setTimeout(() => {
      window.location.reload();
    }, 600);
  };

  const handleRefreshPointerUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleCreateNote = () => {
    setAppError('');
    const now = Date.now();
    const newNote: AppNote = {
      id: crypto.randomUUID(),
      title: 'New Note',
      content: '',
      createdAt: now,
      lockedUntil: null,
      emergencyLength: null,
      hideTypos: false,
      emergencyOpenEnabled: false,
      emergencyOpenPerWeek: 0,
      emergencyOpenLog: [],
      schedule: { enabled: false, days: [], slots: [] },
      updatedAt: now,
      deletedAt: null,
      restricted: false,
    };
    setNotes(prev => [...prev, newNote]);
    setActiveNoteId(newNote.id);
    setUnsavedNoteIds(prev => new Set(prev).add(newNote.id));
  };

  const closePartnerAccess = useCallback(() => {
    setShowPartnerAccess(false);
  }, []);

  const activeNote = notes.find((n) => n.id === activeNoteId);

  return (
    <div className="app-container">
      {!activeNoteId && (
        <header>
          <h1>TimeLock Notes</h1>
          <div className="header-actions">
            <button
              type="button"
              onClick={() => setShowPartnerAccess(true)}
              data-testid="partner-access-open"
            >
              Partner
            </button>
            <button
              onClick={handleRefresh}
              onPointerDown={handleRefreshPointerDown}
              onPointerUp={handleRefreshPointerUp}
              onPointerLeave={handleRefreshPointerUp}
              className="btn-refresh"
              aria-label="Refresh"
            >
              <svg
                className={isRefreshing ? 'refresh-spin' : ''}
                width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button onClick={handleCreateNote} id="create-note-btn" data-testid="create-note">
              + New Note
            </button>
          </div>
        </header>
      )}

      {showPartnerAccess ? (
        <PartnerAccessPanel onClose={closePartnerAccess} />
      ) : null}

      {appError && (
        <div className="error-banner" data-testid="app-error" role="alert">
          {appError}
        </div>
      )}

      <main>
        {activeNoteId && activeNote ? (
          <NoteDetail
            note={activeNote}
            isUnsaved={unsavedNoteIds.has(activeNoteId!)}
            onNoteSaved={(savedNote) => {
              setNotes(prev => [savedNote, ...prev.filter(note => note.id !== savedNote.id)]);
            }}
            onBack={(savedNote) => {
              const noteId = activeNoteId!;
              setUnsavedNoteIds(prev => {
                const next = new Set(prev);
                next.delete(noteId);
                unsavedNoteIdsRef.current = next;
                return next;
              });
              if (savedNote) {
                setNotes(prev => [savedNote, ...prev.filter(note => note.id !== savedNote.id)]);
              }
              setActiveNoteId(null);
              if (!savedNote) {
                loadNotes();
              }
            }}
          />
        ) : activeNoteId ? (
          <div className="loading-spinner">Loading...</div>
        ) : (
          <NoteList notes={notes} onSelectNote={setActiveNoteId} />
        )}
      </main>
    </div>
  );
}

export default App;
