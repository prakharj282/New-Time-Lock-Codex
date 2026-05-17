import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from 'electron';
const electronModule = require('electron');
const { app, BrowserWindow, Tray, Menu, nativeImage } = electronModule;
import path from 'node:path';
import { setupIpcHandlers } from './store';
process.env.APP_ROOT = path.join(__dirname, '..');

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

let win: BrowserWindowType | null;
let tray: TrayType | null;

function createWindow() {
    win = new BrowserWindow({
        width: 800,
        height: 600,
        icon: path.join(process.env.VITE_PUBLIC as string, 'tray-icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    win.on('close', (event) => {
        // Instead of closing the app, just hide the window to keep it in the tray
        if (!(app as any).isQuiting) {
            event.preventDefault();
            win?.hide();
        }
    });

    if (VITE_DEV_SERVER_URL) {
        win.loadURL(VITE_DEV_SERVER_URL);
    } else {
        win.loadFile(path.join(RENDERER_DIST, 'index.html'));
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.whenReady().then(() => {
    app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: [
            '--processStart', `"${process.execPath}"`,
            '--process-start-args', `"--hidden"`
        ]
    });

    setupIpcHandlers();
    createWindow();

    // Setup system tray
    const trayIconPath = path.join(process.env.VITE_PUBLIC as string, 'tray-icon.png');
    const icon = nativeImage.createFromPath(trayIconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show App', click: () => win?.show() },
        { type: 'separator' },
        {
            label: 'Quit', click: () => {
                (app as any).isQuiting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('TimeLock Notes');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        win?.show();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
