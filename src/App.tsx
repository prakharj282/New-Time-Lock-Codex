import { useState, useEffect, useCallback, useRef } from 'react';
import { NoteList } from './components/NoteList';
import { NoteDetail } from './components/NoteDetail';
import * as store from './utils/storage';
import type { Note } from './utils/storage';
import './index.css';

export type AppNote = Note;

function App() {
  const [notes, setNotes] = useState<AppNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [unsavedNoteIds, setUnsavedNoteIds] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const lastTapRef = useRef<number>(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadNotes = useCallback(async () => {
    const loadedNotes = await store.getNotes();
    setNotes(loadedNotes);
  }, []);

  useEffect(() => {
    loadNotes();
    store.fetchLastKnownTime();

    const timeInterval = setInterval(() => {
      store.saveLastKnownTime();
    }, 60_000);

    // Schedule enforcement — check every 30s
    const scheduleInterval = setInterval(async () => {
      const result = await store.applySchedules();
      if (result.updated) {
        setNotes(result.notes);
      }
    }, 30_000);

    // Also check schedules immediately
    const immediateSchedule = setTimeout(async () => {
      const result = await store.applySchedules();
      if (result.updated) {
        setNotes(result.notes);
      }
    }, 1000);

    return () => {
      clearInterval(timeInterval);
      clearInterval(scheduleInterval);
      clearTimeout(immediateSchedule);
    };
  }, []);

  // Re-run schedule checks when notes change
  useEffect(() => {
    if (notes.length === 0) return;
    (async () => {
      const result = await store.applySchedules();
      if (result.updated) {
        setNotes(result.notes);
      }
    })();
  }, [notes.length]);

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
        setNotes(result.notes);
      }
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

  const activeNote = notes.find((n) => n.id === activeNoteId);

  return (
    <div className="app-container">
      {!activeNoteId && (
        <header>
          <h1>TimeLock Notes</h1>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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
            <button onClick={handleCreateNote} id="create-note-btn">
              + New Note
            </button>
          </div>
        </header>
      )}

      <main>
        {activeNoteId && activeNote ? (
          <NoteDetail
            note={activeNote}
            isUnsaved={unsavedNoteIds.has(activeNoteId!)}
            onBack={() => {
              setUnsavedNoteIds(prev => {
                const next = new Set(prev);
                next.delete(activeNoteId!);
                return next;
              });
              setActiveNoteId(null);
              loadNotes();
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
