const { ipcRenderer, contextBridge } = require('electron');

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
    on(channel: string, listener: (...args: any[]) => void) {
        return ipcRenderer.on(channel, (event: any, ...args: any[]) => listener(event, ...args));
    },
    off(channel: string, listener: (...args: any[]) => void) {
        return ipcRenderer.off(channel, listener as any);
    },
    send(channel: string, ...omit: any[]) {
        return ipcRenderer.send(channel, ...(omit as []));
    },
    invoke(channel: string, ...omit: any[]) {
        return ipcRenderer.invoke(channel, ...(omit as []));
    },
});
