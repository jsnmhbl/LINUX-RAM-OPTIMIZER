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
  listPorts: () => ipcRenderer.invoke('ports:list'),
  listPrograms: () => ipcRenderer.invoke('programs:list'),
  removePrograms: (programs) => ipcRenderer.invoke('programs:remove', { programs }),
  listAutostart: () => ipcRenderer.invoke('autostart:list'),
  setAutostart: (payload) => ipcRenderer.invoke('autostart:set', payload),
  onOptimizeEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('optimize:event', listener);
    return () => ipcRenderer.removeListener('optimize:event', listener);
  },
  onShowTab: (handler) => {
    const listener = (_event, tab) => handler(tab);
    ipcRenderer.on('ui:tab', listener);
    return () => ipcRenderer.removeListener('ui:tab', listener);
  },
});
