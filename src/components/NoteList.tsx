import type { AppNote } from '../App';
import { NoteCard } from './NoteCard';

interface NoteListProps {
    notes: AppNote[];
    onSelectNote: (id: string) => void;
}

export function NoteList({ notes, onSelectNote }: NoteListProps) {
    if (notes.length === 0) {
        return (
            <div className="empty-state">
                <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                </svg>
                <div className="empty-state-title">No notes yet</div>
                <div className="empty-state-subtitle">
                    Create your first note and lock it away with a timer to stay focused.
                </div>
            </div>
        );
    }

    return (
        <div className="note-grid">
            {notes.map((note, index) => (
                <NoteCard
                    key={note.id}
                    note={note}
                    onClick={() => onSelectNote(note.id)}
                    index={index}
                />
            ))}
        </div>
    );
}
