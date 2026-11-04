'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const USER_AUTOSTART_DIR = path.join(HOME, '.config', 'autostart');
const SYSTEM_AUTOSTART_DIR = '/etc/xdg/autostart';
const BACKUP_DIR = path.join(USER_AUTOSTART_DIR, 'disabled-by-ram-opt');
const STATE_DIR = path.join(HOME, '.local', 'state', 'ram-optimizer');
const STATE_FILE = path.join(STATE_DIR, 'autostart-state.json');

/** Units die je beter niet uitzet: zonder deze valt je sessie of je audio weg. */
const PROTECTED_UNITS = [
  /^dbus(-broker)?\.(service|socket)$/,
  /^org\.freedesktop\./,
  /^pipewire/,
  /^wireplumber/,
  /^systemd-/,
  /^graphical-session/,
  /^user@/,
  /^session-/,
];

const HIDDEN_KEY = 'Hidden=true';

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: err || null,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* .desktop-bestanden                                                   */
/* ------------------------------------------------------------------ */

function parseDesktop(content) {
  const entries = {};
  let section = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section !== 'Desktop Entry') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    entries[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return entries;
}

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Staat het bestand uit? */
function desktopDisabled(parsed) {
  if (parsed.Hidden && parsed.Hidden.toLowerCase() === 'true') return true;
  const gnome = parsed['X-GNOME-Autostart-enabled'];
  if (gnome && gnome.toLowerCase() === 'false') return true;
  return false;
}

/** Haal het binaire pad uit een Exec-regel. */
function binaryFromExec(exec = '') {
  const quoted = exec.trim().match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  const parts = exec.trim().split(/\s+/);
  for (const part of parts) {
    if (part === 'env') continue;
    if (part.includes('=') && !part.startsWith('/') && !part.startsWith('~')) continue;
    if (part.startsWith('%')) continue;
    return part;
  }
  return null;
}

/** Zoek een programma in het PATH. */
function findInPath(command) {
  if (!command || command.includes('/')) return null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* volgende map */
    }
  }
  return null;
}

/** Bestaat het programma dat in de Exec-regel genoemd wordt? */
function binaryExists(binary) {
  if (!binary) return true;
  const resolved = binary.replace('~', HOME);
  if (resolved.includes('/')) return fs.existsSync(resolved);
  return Boolean(findInPath(resolved));
}

/**
 * Alle auto-start items: desktop-bestanden van de gebruiker én van het systeem.
 * Een bestand in de eigen map overschrijft het systeemversie.
 */
async function listDesktopEntries() {
  const userFiles = (await readDirSafe(USER_AUTOSTART_DIR)).filter((f) => f.endsWith('.desktop'));
  const systemFiles = (await readDirSafe(SYSTEM_AUTOSTART_DIR)).filter((f) => f.endsWith('.desktop'));
  const names = [...new Set([...userFiles, ...systemFiles])].sort((a, b) => a.localeCompare(b, 'nl'));

  const entries = [];
  for (const name of names) {
    const userPath = path.join(USER_AUTOSTART_DIR, name);
    const systemPath = path.join(SYSTEM_AUTOSTART_DIR, name);
    const isUser = fs.existsSync(userPath);
    const target = isUser ? userPath : systemPath;
    if (!fs.existsSync(target)) continue;

    let content = '';
    try {
      content = await fsp.readFile(target, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDesktop(content);
    const exec = parsed.Exec || '';
    const binary = binaryFromExec(exec);
    const executableMissing = !binaryExists(binary);

    entries.push({
      kind: 'desktop',
      id: `desktop:${name}`,
      name: parsed.Name || name.replace(/\.desktop$/, ''),
      file: name,
      source: isUser ? 'gebruiker' : 'systeem',
      path: target,
      enabled: !desktopDisabled(parsed),
      exec,
      binary,
      executableMissing,
      comment: parsed.Comment || '',
      onlyShowIn: parsed.OnlyShowIn || '',
      notShowIn: parsed.NotShowIn || '',
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* systemd user units                                                   */
/* ------------------------------------------------------------------ */

async function listEnabledUnits(type) {
  const { stdout } = await run('systemctl', [
    '--user',
    'list-unit-files',
    `--type=${type}`,
    '--state=enabled',
    '--no-legend',
    '--no-pager',
  ]);
  const units = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) continue;
    const [unit, state] = parts;
    if (!unit || !unit.includes('.')) continue;
    if (state !== 'enabled') continue;
    units.push(unit);
  }
  return units;
}

/** Actieve state van alle geladen user units in één keer ophalen. */
async function activeStates() {
  const { stdout } = await run('systemctl', [
    '--user',
    'list-units',
    '--all',
    '--no-legend',
    '--no-pager',
    '--plain',
  ]);
  const states = new Map();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [unit, , , active] = parts;
    if (unit && active) states.set(unit, active);
  }
  return states;
}

/** Wanneer gaat een timer de volgende keer lopen? */
async function timerNextRuns() {
  const { stdout } = await run('systemctl', ['--user', 'list-timers', '--all', '--no-legend', '--no-pager']);
  const next = new Map();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    next.set(parts[1], parts[0]);
  }
  return next;
}

async function listUnitEntries() {
  const [services, timers, states, nextRuns] = await Promise.all([
    listEnabledUnits('service'),
    listEnabledUnits('timer'),
    activeStates(),
    timerNextRuns(),
  ]);

  const entries = [];
  const push = (unit, type) => {
    const protectedUnit = PROTECTED_UNITS.some((re) => re.test(unit));
    entries.push({
      kind: 'unit',
      id: `unit:${unit}`,
      name: unit,
      file: unit,
      source: 'systemd',
      unit,
      unitType: type,
      enabled: true,
      active: states.get(unit) || 'inactive',
      protected: protectedUnit,
      nextRun: type === 'timer' ? nextRuns.get(unit) || null : null,
    });
  };

  for (const unit of services) push(unit, 'service');
  for (const unit of timers) push(unit, 'timer');

  entries.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  return entries;
}

/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */

/** Alles wat bij het opstarten van de sessie meelopt. */
async function listAutostart() {
  const [desktop, units] = await Promise.all([listDesktopEntries(), listUnitEntries()]);

  const entries = [...desktop, ...units];
  const enabled = entries.filter((e) => e.enabled);

  return {
    entries,
    summary: {
      total: entries.length,
      enabled: enabled.length,
      disabled: entries.length - enabled.length,
      desktop: desktop.length,
      units: units.length,
      stale: entries.filter((e) => e.executableMissing).length,
    },
    at: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Aan/uit zetten                                                        */
/* ------------------------------------------------------------------ */

/** Schrijf een shadow-bestand dat het systeem-item uitschakelt. */
async function writeShadow(name, content) {
  await fsp.mkdir(USER_AUTOSTART_DIR, { recursive: true });
  const target = path.join(USER_AUTOSTART_DIR, name);
  const updated = content
    .replace(/^Hidden=.*$/gm, '')
    .replace(/^X-GNOME-Autostart-enabled=.*$/gm, '')
    .replace('[Desktop Entry]', `[Desktop Entry]\n${HIDDEN_KEY}\nX-GNOME-Autostart-enabled=false`);
  await fsp.writeFile(target, updated);
  return target;
}

/** Haal de verberg-vlaggen weer uit een bestand. */
async function unhideFile(target) {
  const content = await fsp.readFile(target, 'utf8');
  const cleaned = content
    .replace(/^Hidden=.*$/gm, '')
    .replace(/^X-GNOME-Autostart-enabled=.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  await fsp.writeFile(target, cleaned);
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeState(state) {
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return STATE_FILE;
}

/**
 * Zet een auto-start item aan of uit.
 * Desktop-items krijgen een shadow-bestand in de eigen map; systemd-units
 * worden met systemctl --user uitgeschakeld (en gemaskeerd als het een timer is).
 */
async function setEnabled({ kind, id, enabled }) {
  const state = await readState();

  if (kind === 'desktop') {
    const name = id.startsWith('desktop:') ? id.slice('desktop:'.length) : id;
    const userPath = path.join(USER_AUTOSTART_DIR, name);
    const systemPath = path.join(SYSTEM_AUTOSTART_DIR, name);

    if (!enabled) {
      const isUser = fs.existsSync(userPath);
      const source = isUser ? userPath : systemPath;
      if (!fs.existsSync(source)) return { status: 'error', message: 'Bestand niet gevonden' };

      const content = await fsp.readFile(source, 'utf8');
      const parsed = parseDesktop(content);

      // Bij een eigen bestand eerst de originele inhoud bewaren.
      let backup = null;
      if (isUser) {
        await fsp.mkdir(BACKUP_DIR, { recursive: true });
        backup = path.join(BACKUP_DIR, `${name}.orig`);
        if (!fs.existsSync(backup)) await fsp.writeFile(backup, content);
      }

      const shadow = await writeShadow(name, content);
      record(state, {
        kind: 'desktop',
        id,
        name: parsed.Name || name,
        file: name,
        shadow,
        backup,
        origin: isUser ? 'gebruiker' : 'systeem',
      });
      await writeState(state);
      return { status: 'ok', message: `${parsed.Name || name} start niet meer mee` };
    }

    // Weer aanzetten.
    const saved = state.entries.find((e) => e.id === id && e.kind === 'desktop');
    if (saved) {
      if (saved.origin === 'systeem') {
        // Eigen shadow-bestand weg, het systeem-item doet het weer zelf.
        if (fs.existsSync(saved.shadow)) await fsp.rm(saved.shadow, { force: true });
      } else if (saved.backup && fs.existsSync(saved.backup)) {
        await fsp.copyFile(saved.backup, userPath);
        await fsp.rm(saved.backup, { force: true });
      } else if (fs.existsSync(userPath)) {
        await unhideFile(userPath);
      }
    } else if (fs.existsSync(userPath)) {
      // Geen state meer: als er ook een systeemversie is, is dit ons shadow-bestand.
      if (fs.existsSync(systemPath)) {
        await fsp.rm(userPath, { force: true });
      } else {
        await unhideFile(userPath);
      }
    }

    state.entries = state.entries.filter((e) => !(e.id === id && e.kind === 'desktop'));
    await writeState(state);
    return { status: 'ok', message: `${name} start weer mee` };
  }

  if (kind === 'unit') {
    const unit = id.startsWith('unit:') ? id.slice('unit:'.length) : id;
    const isTimer = unit.endsWith('.timer');

    if (!enabled) {
      const disable = await run('systemctl', ['--user', 'disable', '--now', unit]);
      if (disable.code !== 0 && !/not been loaded/i.test(disable.stderr)) {
        return { status: 'error', message: disable.stderr.trim() || 'Uitschakelen mislukt' };
      }
      if (isTimer) await run('systemctl', ['--user', 'mask', unit]);
      const active = await run('systemctl', ['--user', 'is-active', unit]);
      record(state, {
        kind: 'unit',
        id,
        name: unit,
        unit,
        unitType: isTimer ? 'timer' : 'service',
        wasActive: active.stdout.trim() === 'active',
      });
      await writeState(state);
      return { status: 'ok', message: `${unit} uitgeschakeld` };
    }

    if (isTimer) await run('systemctl', ['--user', 'unmask', unit]);
    const enable = await run('systemctl', ['--user', 'enable', '--now', unit]);
    state.entries = state.entries.filter((e) => !(e.id === id && e.kind === 'unit'));
    await writeState(state);
    if (enable.code !== 0) {
      return { status: 'warn', message: enable.stderr.trim() || 'Inschakelen mislukt' };
    }
    return { status: 'ok', message: `${unit} ingeschakeld` };
  }

  return { status: 'error', message: `Onbekend type: ${kind}` };
}

function record(state, entry) {
  const index = state.entries.findIndex((e) => e.id === entry.id && e.kind === entry.kind);
  if (index === -1) state.entries.push(entry);
  else state.entries[index] = entry;
}

/** Zet alle auto-start items terug zoals ze waren. */
async function restoreAll() {
  const state = await readState();
  const results = [];

  for (const entry of state.entries) {
    if (entry.kind === 'desktop') {
      try {
        if (entry.origin === 'systeem') {
          // Shadow-bestand weg: het systeem-item start weer vanzelf mee.
          if (entry.shadow && fs.existsSync(entry.shadow)) {
            await fsp.rm(entry.shadow, { force: true });
          }
        } else if (entry.backup && fs.existsSync(entry.backup)) {
          await fsp.copyFile(entry.backup, path.join(USER_AUTOSTART_DIR, entry.file));
          await fsp.rm(entry.backup, { force: true });
        } else if (entry.shadow && fs.existsSync(entry.shadow)) {
          await unhideFile(entry.shadow);
        }
        results.push({ label: entry.name, status: 'ok', message: 'Hersteld' });
      } catch (error) {
        results.push({ label: entry.name, status: 'warn', message: error.message });
      }
      continue;
    }

    if (entry.kind === 'unit') {
      if (entry.unitType === 'timer') await run('systemctl', ['--user', 'unmask', entry.unit]);
      const enable = await run('systemctl', ['--user', 'enable', '--now', entry.unit]);
      results.push({
        label: entry.name,
        status: enable.code === 0 ? 'ok' : 'warn',
        message: enable.code === 0 ? 'Hersteld en gestart' : enable.stderr.trim() || 'Herstel mislukt',
      });
    }
  }

  state.entries = [];
  await writeState(state);
  return results;
}

module.exports = {
  listAutostart,
  listDesktopEntries,
  listUnitEntries,
  setEnabled,
  restoreAll,
  USER_AUTOSTART_DIR,
  SYSTEM_AUTOSTART_DIR,
  STATE_FILE,
};
