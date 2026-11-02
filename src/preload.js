'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ram', {
  scan: () => ipcRenderer.invoke('scan'),
  optimize: (steps) => ipcRenderer.invoke('optimize', { steps }),
  restore: () => ipcRenderer.invoke('restore'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  openReportFolder: () => ipcRenderer.invoke('report:open'),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  onOptimizeEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('optimize:event', listener);
    return () => ipcRenderer.removeListener('optimize:event', listener);
  },
});
