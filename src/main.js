'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const optimizer = require('./optimizer');
const network = require('./network');
const programs = require('./programs');
const autostart = require('./autostart');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;

/* Zorg dat systemctl --user kan praten met de sessiebus, ook als de app
   vanuit een terminal of een snelkoppeling gestart is. */
if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
  const uid = process.getuid?.() ?? 1000;
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  process.env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { autoOptimize: false, steps: optimizer.STEP_DEFINITIONS.map((s) => s.id) };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** Lees een commando-regeloptie: `--naam waarde` of `--naam=waarde`. */
function readArg(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 880,
    minWidth: 780,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    title: 'RAM Optimizer',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Ontwikkelhulp: `electron . --screenshot /pad/naar.png` maakt een screenshot en sluit af.
  // Met `--tab=poorten` springt hij eerst naar dat tabblad.
  const shotTarget = readArg('--screenshot');
  if (shotTarget) {
    const tab = readArg('--tab');
    mainWindow.webContents.once('did-finish-load', async () => {
      if (tab) mainWindow.webContents.send('ui:tab', tab);
      await new Promise((r) => setTimeout(r, 2500));
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(shotTarget, image.toPNG());
      console.log(`screenshot: ${shotTarget}`);
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------- IPC ------------------------------- */

ipcMain.handle('scan', () => optimizer.scan());

ipcMain.handle('optimize', async (_event, { steps }) => {
  const settings = readSettings();
  const selected = Array.isArray(steps) && steps.length ? steps : settings.steps;
  const report = await optimizer.optimize({
    steps: selected,
    onEvent: (event) => mainWindow?.webContents.send('optimize:event', event),
  });
  writeSettings({ ...settings, steps: selected });
  return report;
});

ipcMain.handle('restore', async () => {
  const result = await optimizer.restore({
    onEvent: (event) => mainWindow?.webContents.send('optimize:event', event),
  });
  return result;
});

ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:set', (_event, settings) => {
  const current = readSettings();
  const merged = { ...current, ...settings };
  writeSettings(merged);
  return merged;
});

ipcMain.handle('ports:list', () => network.listPorts());

ipcMain.handle('programs:list', () => programs.listPrograms());

ipcMain.handle('programs:remove', async (_event, payload) => {
  const list = Array.isArray(payload?.programs) ? payload.programs : [];
  if (!list.length) return { results: [], removed: 0 };
  return programs.removePrograms(list);
});

ipcMain.handle('autostart:list', () => autostart.listAutostart());

ipcMain.handle('autostart:set', async (_event, payload) => {
  const { kind, id, enabled } = payload || {};
  if (!kind || !id) return { status: 'error', message: 'Onbekend item' };
  return autostart.setEnabled({ kind, id, enabled: Boolean(enabled) });
});

ipcMain.handle('report:open', async () => {
  const target = optimizer.REPORT_DIR;
  await fs.promises.mkdir(target, { recursive: true });
  shell.openPath(target);
  return target;
});

ipcMain.handle('dialog:confirm', async (_event, { title, message, detail }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Annuleren', 'Doen'],
    defaultId: 1,
    cancelId: 0,
    title: title || 'Bevestigen',
    message: message || '',
    detail: detail || '',
  });
  return response === 1;
});
