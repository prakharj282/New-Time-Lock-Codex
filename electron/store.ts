const { app, ipcMain } = require('electron');
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_ROOT = path.join(__dirname, '..');
const MAIN_DIST = path.join(APP_ROOT, 'dist-electron');
const RENDERER_DIST = path.join(APP_ROOT, 'dist');
const VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL ? path.join(APP_ROOT, 'public') : RENDERER_DIST;

export interface ScheduleSlot {
    start: string;
    end: string;
}

export interface NoteSchedule {
    enabled: boolean;
    days: number[];
    slots: ScheduleSlot[];
    timezone?: string;
}

export interface Note {
    id: string;
    title: string;
    content: string;
    createdAt: number;
    lockedUntil: number | null;
    emergencyLength: number | null;
    hideTypos: boolean;
    emergencyOpenEnabled: boolean;
    emergencyOpenPerWeek: number;
    emergencyOpenLog: number[];
    schedule?: NoteSchedule;
    updatedAt?: number;
    deletedAt?: number | null;
}

const ALGORITHM = 'aes-256-gcm';

class SecureStore {
    private userDataPath: string;
    private dbPath: string;
    private keyPath: string;
    private encryptionKey: Buffer;

    constructor() {
        this.userDataPath = app.getPath('userData');
        this.dbPath = path.join(this.userDataPath, 'notes.json');
        this.keyPath = path.join(this.userDataPath, 'key.bin');

        this.encryptionKey = this.initEncryptionKey();
        if (!fs.existsSync(this.dbPath)) {
            this.writeDb([]);
        }
    }

    private initEncryptionKey(): Buffer {
        if (fs.existsSync(this.keyPath)) {
            return fs.readFileSync(this.keyPath);
        }
        const key = crypto.randomBytes(32);
        fs.writeFileSync(this.keyPath, key);
        return key;
    }

    private encrypt(text: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    private decrypt(encryptedText: string): string {
        const parts = encryptedText.split(':');
        if (parts.length !== 3) return encryptedText;
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const text = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(text, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    private readDb(): Note[] {
        try {
            const data = fs.readFileSync(this.dbPath, 'utf8');
            const nodes: Note[] = JSON.parse(data);
            return nodes;
        } catch {
            return [];
        }
    }

    private writeDb(data: Note[]) {
        fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf8');
    }

    public getNotes(): Note[] {
        return this.readDb();
    }

    public getNoteContent(id: string): string | null {
        const notes = this.readDb();
        const note = notes.find((n) => n.id === id);
        if (!note) return null;
        try {
            if (note.content) return this.decrypt(note.content);
            return '';
        } catch {
            return '';
        }
    }

    public saveNote(note: Note, rawContent: string) {
        const notes = this.readDb();
        const existingIndex = notes.findIndex((n) => n.id === note.id);

        note.content = this.encrypt(rawContent);

        if (existingIndex >= 0) {
            notes[existingIndex] = note;
        } else {
            notes.push(note);
        }
        this.writeDb(notes);
    }

    public deleteNote(id: string) {
        let notes = this.readDb();
        notes = notes.filter((n) => n.id !== id);
        this.writeDb(notes);
    }

    public extendLock(id: string, additionalMs: number) {
        const notes = this.readDb();
        const note = notes.find((n) => n.id === id);
        if (!note || !note.lockedUntil) return false;
        note.lockedUntil = note.lockedUntil + additionalMs;
        this.writeDb(notes);
        return note.lockedUntil;
    }

    public setEmergencyLength(id: string, newLength: number) {
        const notes = this.readDb();
        const note = notes.find((n) => n.id === id);
        if (!note) return false;
        const current = note.emergencyLength || 50;
        if (newLength <= current) return false;
        note.emergencyLength = newLength;
        this.writeDb(notes);
        return note.emergencyLength;
    }

    public setLockUntil(id: string, timestamp: number) {
        const notes = this.readDb();
        const note = notes.find((n) => n.id === id);
        if (!note) return false;
        note.lockedUntil = timestamp;
        this.writeDb(notes);
        return note.lockedUntil;
    }

    // Clock tampering prevention
    private get timePath() {
        return path.join(this.userDataPath, 'last_known_time.json');
    }

    public saveLastKnownTime() {
        fs.writeFileSync(this.timePath, JSON.stringify({ time: Date.now() }), 'utf8');
    }

    public getLastKnownTime(): number {
        try {
            const data = JSON.parse(fs.readFileSync(this.timePath, 'utf8'));
            return data.time || 0;
        } catch {
            return 0;
        }
    }

    public useEmergencyOpen(id: string): { success: boolean; error?: string; usedThisWeek?: number; limit?: number } {
        const notes = this.readDb();
        const note = notes.find((n) => n.id === id);
        if (!note) return { success: false, error: 'not_found' };
        if (!note.emergencyOpenEnabled) return { success: false, error: 'not_enabled' };
        if (!note.lockedUntil || note.lockedUntil <= Date.now()) return { success: false, error: 'not_locked' };

        const now = new Date();
        const dayOfWeek = now.getDay();
        const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - daysSinceMonday);
        weekStart.setHours(0, 0, 0, 0);
        const weekStartMs = weekStart.getTime();

        const log = note.emergencyOpenLog || [];
        const usedThisWeek = log.filter((t: number) => t >= weekStartMs).length;

        if (usedThisWeek >= note.emergencyOpenPerWeek) {
            return { success: false, error: 'quota_exhausted', usedThisWeek, limit: note.emergencyOpenPerWeek };
        }

        note.emergencyOpenLog = [...log, Date.now()];
        note.lockedUntil = null;
        this.writeDb(notes);
        return { success: true, usedThisWeek: usedThisWeek + 1, limit: note.emergencyOpenPerWeek };
    }
}

let store: SecureStore | null = null;

export function setupIpcHandlers() {
    if (!store) {
        store = new SecureStore();
    }

    ipcMain.handle('getNotes', () => {
        return store!.getNotes();
    });

    ipcMain.handle('getNoteContent', (_, id: string) => {
        return store!.getNoteContent(id);
    });

    ipcMain.handle('saveNote', (_, note: Note, rawContent: string) => {
        store!.saveNote(note, rawContent);
        return true;
    });

    ipcMain.handle('deleteNote', (_, id: string) => {
        store!.deleteNote(id);
        return true;
    });

    ipcMain.handle('extendLock', (_, id: string, additionalMs: number) => {
        return store!.extendLock(id, additionalMs);
    });

    ipcMain.handle('setEmergencyLength', (_, id: string, newLength: number) => {
        return store!.setEmergencyLength(id, newLength);
    });

    ipcMain.handle('setLockUntil', (_, id: string, timestamp: number) => {
        return store!.setLockUntil(id, timestamp);
    });

    ipcMain.handle('saveLastKnownTime', () => {
        store!.saveLastKnownTime();
        return true;
    });

    ipcMain.handle('getLastKnownTime', () => {
        return store!.getLastKnownTime();
    });

    ipcMain.handle('useEmergencyOpen', (_, id: string) => {
        return store!.useEmergencyOpen(id);
    });
}
