'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const LOCAL_APPLICATIONS_DIR = path.join(HOME, '.local', 'share', 'applications');
const USER_BIN_DIR = path.join(HOME, '.local', 'bin');
const TRASH_DIR = path.join(HOME, '.local', 'share', 'Trash');
const TRASH_FILES = path.join(TRASH_DIR, 'files');
const TRASH_INFO = path.join(TRASH_DIR, 'info');

/** Mappen waar gebruikers zelf AppImages en losse programma's neerzetten. */
const APPIMAGE_DIRS = [
  path.join(HOME, 'AppImages'),
  path.join(HOME, 'Applications'),
  path.join(HOME, 'appimages'),
  path.join(HOME, 'apps'),
  USER_BIN_DIR,
];

const APPIMAGE_EXTENSIONS = ['.appimage', '.appimage.zsync', '.appimagetool'];

/* ------------------------------------------------------------------ */
/* Hulpjes                                                               */
/* ------------------------------------------------------------------ */

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 60000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: err || null,
      });
    });
  });
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function formatSize(bytes) {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Lees een .desktop-bestand als een eenvoudige sleutel/waarde-map. */
function parseDesktopFile(content) {
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

/**
 * Haal het pad van het programma uit een Exec-regel.
 * `env FOO=1 /pad/naar/app --flag %U` → `/pad/naar/app`
 */
function binaryFromExec(exec = '') {
  if (!exec) return null;
  let value = exec.trim();
  const quoted = value.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];

  const parts = value.split(/\s+/);
  for (const part of parts) {
    if (part.includes('=') && !part.startsWith('/') && !part.startsWith('~')) continue;
    if (part.startsWith('%')) continue;
    if (part === 'env') continue;
    return part;
  }
  return null;
}

function isAppImagePath(target) {
  const lower = target.toLowerCase();
  if (APPIMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return lower.endsWith('.appimage');
}

/** Check de AppImage-magic bytes (ELF + "AI\x02" op offset 8). */
async function hasAppImageMagic(file) {
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(11);
      const { bytesRead } = await handle.read(buffer, 0, 11, 0);
      if (bytesRead < 11) return false;
      return buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[8] === 0x41 && buffer[9] === 0x49;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Is dit pad veilig om te verwijderen? Alleen binnen de eigen homedirectory. */
function isSafeToRemove(target) {
  const resolved = path.resolve(target);
  if (resolved === HOME || resolved === path.parse(HOME).root) return false;
  if (!resolved.startsWith(`${HOME}${path.sep}`)) return false;
  if (/ram-?optimizer/i.test(resolved)) return false;
  return true;
}

/** Zoek een programma in het PATH (voor Exec-regels zonder volledig pad). */
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

/* ------------------------------------------------------------------ */
/* Prullenbak (XDG Trash)                                                */
/* ------------------------------------------------------------------ */

function trashInfoName(fileName) {
  return `${fileName}.trashinfo`;
}

function uniqueTrashName(fileName) {
  let candidate = fileName;
  let counter = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!fs.existsSync(path.join(TRASH_FILES, candidate))) return candidate;
    counter += 1;
    candidate = `${fileName}.${counter}`;
  }
}

/**
 * Verplaats een bestand of map naar de prullenbak.
 * Dankzij de XDG-prullenbak blijft alles terug te halen.
 */
async function moveToTrash(target) {
  if (!isSafeToRemove(target)) {
    throw new Error(`Buiten je eigen map: ${target}`);
  }
  await fsp.mkdir(TRASH_FILES, { recursive: true });
  await fsp.mkdir(TRASH_INFO, { recursive: true });

  const stat = await fsp.lstat(target);
  const base = path.basename(target);
  const name = uniqueTrashName(base);

  const info = [
    '[Trash Info]',
    `Path=${encodeURIComponent(path.resolve(target))}`,
    `DeletionDate=${new Date().toISOString().slice(0, 19)}`,
    '',
  ].join('\n');
  await fsp.writeFile(path.join(TRASH_INFO, trashInfoName(name)), info);

  const destination = path.join(TRASH_FILES, name);
  try {
    await fsp.rename(target, destination);
  } catch {
    // Ander bestandssysteem: kopiëren en dan verwijderen.
    await fsp.cp(target, destination, { recursive: true, preserveTimestamps: true });
    await fsp.rm(target, { recursive: true, force: true });
  }

  return { name, size: stat.size, isDirectory: stat.isDirectory() };
}

/* ------------------------------------------------------------------ */
/* Scannen                                                               */
/* ------------------------------------------------------------------ */

async function listFlatpaks() {
  const { stdout, code } = await run('flatpak', [
    'list',
    '--app',
    '--columns=application,name,version,origin,installation,size',
  ]);
  if (code !== 0 && !stdout.trim()) return [];

  const apps = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [id, name, version, origin, installation, size] = line.split('\t');
    apps.push({
      source: 'flatpak',
      id,
      name: name || id,
      version: version || '',
      origin: origin || '',
      installation: installation || 'user',
      size: size || '',
      removable: true,
      needsAdmin: installation === 'system',
    });
  }
  return apps;
}

async function listSnaps() {
  const { stdout, code } = await run('snap', ['list']);
  if (code !== 0 || !stdout.trim()) return [];

  const snaps = [];
  const lines = stdout.split('\n').filter((line) => line.trim());
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [name, version, rev, tracking, publisher, ...notes] = parts;
    if (!name || name === 'Name') continue;
    snaps.push({
      source: 'snap',
      id: name,
      name,
      version: version || '',
      revision: rev || '',
      tracking: tracking || '',
      publisher: publisher || '',
      notes: notes.join(' ') || '-',
      removable: true,
      needsAdmin: true,
    });
  }
  return snaps;
}

/** Verzamel losse desktop-bestanden uit de eigen applications-map. */
async function listLocalDesktopEntries() {
  let files = [];
  try {
    files = await fsp.readdir(LOCAL_APPLICATIONS_DIR);
  } catch {
    return [];
  }

  const entries = [];
  for (const file of files) {
    if (!file.endsWith('.desktop')) continue;
    const full = path.join(LOCAL_APPLICATIONS_DIR, file);
    let content = '';
    try {
      content = await fsp.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDesktopFile(content);
    if (parsed.Type && parsed.Type !== 'Application') continue;

    const exec = binaryFromExec(parsed.Exec);
    entries.push({
      file,
      path: full,
      name: parsed.Name || file.replace(/\.desktop$/, ''),
      exec: parsed.Exec || '',
      binary: exec,
      icon: parsed.Icon || '',
      comment: parsed.Comment || '',
      noDisplay: parsed.NoDisplay === 'true',
    });
  }
  return entries;
}

/** Zoek AppImages in de bekende mappen. */
async function findAppImages() {
  const found = new Map();
  for (const dir of APPIMAGE_DIRS) {
    if (!(await pathExists(dir))) continue;
    let files = [];
    try {
      files = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of files) {
      if (!item.isFile()) continue;
      const full = path.join(dir, item.name);
      const byName = isAppImagePath(full);
      const byMagic = !byName && (await hasAppImageMagic(full));
      if (!byName && !byMagic) continue;
      if (!found.has(full)) {
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          size = 0;
        }
        found.set(full, { path: full, name: item.name, size, formatSize: formatSize(size) });
      }
    }
  }
  return [...found.values()];
}

/**
 * Alle geïnstalleerde programma's die de app kan zien.
 * Flatpak, snap, AppImage en losse desktop-snelkoppelingen.
 */
async function listPrograms() {
  const [flatpaks, snaps, desktopEntries, appImages] = await Promise.all([
    listFlatpaks(),
    listSnaps(),
    listLocalDesktopEntries(),
    findAppImages(),
  ]);

  const appImageByPath = new Map(appImages.map((item) => [item.path, item]));
  const programs = [];
  const handledBinaries = new Set();

  // 1. Desktop-snelkoppelingen groeperen per programma.
  const byBinary = new Map();
  for (const entry of desktopEntries) {
    const binary = entry.binary ? path.resolve(entry.binary.replace('~', HOME)) : null;
    if (!binary) continue;
    if (!byBinary.has(binary)) byBinary.set(binary, []);
    byBinary.get(binary).push(entry);
  }

  for (const [binary, entries] of byBinary) {
    if (!binary.startsWith(HOME)) continue;
    if (handledBinaries.has(binary)) continue;
    handledBinaries.add(binary);

    const appImage = appImageByPath.get(binary);
    const inOwnBin = binary.startsWith(USER_BIN_DIR) || binary.startsWith(path.join(HOME, 'bin'));
    if (!appImage && !inOwnBin) continue;

    const primary = entries[0];
    let size = 0;
    try {
      size = (await fsp.stat(binary)).size;
    } catch {
      size = 0;
    }

    programs.push({
      source: appImage ? 'appimage' : 'desktop',
      id: binary,
      name: appImage ? primary.name || appImage.name : primary.name,
      version: '',
      path: binary,
      formatSize: appImage ? appImage.formatSize : formatSize(size),
      size,
      icon: primary.icon,
      detail: appImage ? 'AppImage' : 'Eigen programma',
      desktopEntries: entries.map((entry) => entry.file),
      removable: isSafeToRemove(binary),
    });
  }

  // 2. AppImages zonder snelkoppeling.
  for (const item of appImages) {
    if (handledBinaries.has(item.path)) continue;
    handledBinaries.add(item.path);
    programs.push({
      source: 'appimage',
      id: item.path,
      name: item.name.replace(/\.(appimage|AppImage)$/, ''),
      version: '',
      path: item.path,
      formatSize: item.formatSize,
      size: item.size,
      icon: '',
      detail: 'AppImage',
      desktopEntries: [],
      removable: isSafeToRemove(item.path),
    });
  }

  // 3. Pakketbeheerders.
  for (const app of flatpaks) {
    programs.push({
      source: 'flatpak',
      id: app.id,
      name: app.name,
      version: app.version,
      path: null,
      formatSize: app.size,
      size: 0,
      icon: '',
      detail: `Flatpak · ${app.origin || 'onbekend'} · ${app.installation}`,
      desktopEntries: [],
      removable: app.removable,
      needsAdmin: app.needsAdmin,
    });
  }

  for (const snap of snaps) {
    programs.push({
      source: 'snap',
      id: snap.id,
      name: snap.name,
      version: snap.version,
      path: null,
      formatSize: '',
      size: 0,
      icon: '',
      detail: `Snap · ${snap.publisher || 'onbekende uitgever'}`,
      desktopEntries: [],
      removable: snap.removable,
      needsAdmin: snap.needsAdmin,
    });
  }

  programs.sort((a, b) => a.name.localeCompare(b.name, 'nl'));

  return {
    programs,
    summary: {
      total: programs.length,
      flatpak: flatpaks.length,
      snap: snaps.length,
      appimage: programs.filter((p) => p.source === 'appimage').length,
      desktop: programs.filter((p) => p.source === 'desktop').length,
      removable: programs.filter((p) => p.removable).length,
    },
    at: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Verwijderen                                                           */
/* ------------------------------------------------------------------ */

/**
 * Verwijder één programma.
 * Flatpak en snap gaan via hun eigen pakketbeheer; bestanden gaan naar de
 * XDG-prullenbak zodat je ze terug kunt halen.
 */
async function removeProgram({ source, id, desktopEntries = [] }) {
  const result = { source, id, status: 'ok', message: '', removed: [] };

  if (source === 'flatpak') {
    const { stdout, code, stderr } = await run('flatpak', ['uninstall', '--user', '--noninteractive', id]);
    if (code !== 0) {
      // System-installaties vragen om beheerderrechten.
      const admin = await run('pkexec', ['flatpak', 'uninstall', '--system', '--noninteractive', id], {
        timeout: 120000,
      });
      if (admin.code !== 0) {
        return {
          ...result,
          status: 'error',
          message: admin.stderr.trim() || stdout.trim() || 'Verwijderen mislukt',
        };
      }
    }
    result.removed.push(id);
    result.message = `${id} verwijderd (flatpak)`;
    return result;
  }

  if (source === 'snap') {
    const { stderr, code } = await run('pkexec', ['snap', 'remove', id], { timeout: 120000 });
    if (code !== 0) {
      return { ...result, status: 'error', message: stderr.trim() || 'Verwijderen mislukt (beheerder?)' };
    }
    result.removed.push(id);
    result.message = `${id} verwijderd (snap)`;
    return result;
  }

  if (source === 'appimage' || source === 'desktop') {
    if (!isSafeToRemove(id)) {
      return { ...result, status: 'error', message: 'Buiten je eigen map — niet verwijderd' };
    }
    try {
      const moved = await moveToTrash(id);
      result.removed.push(moved.name);
      result.message = `${path.basename(id)} naar de prullenbak verplaatst`;
    } catch (error) {
      return { ...result, status: 'error', message: error.message };
    }

    for (const desktop of desktopEntries) {
      const full = path.join(LOCAL_APPLICATIONS_DIR, desktop);
      if (!isSafeToRemove(full)) continue;
      try {
        await moveToTrash(full);
        result.removed.push(desktop);
      } catch {
        /* snelkoppeling blijft staan */
      }
    }
    return result;
  }

  return { ...result, status: 'error', message: `Onbekend type: ${source}` };
}

/** Verwijder meerdere programma's; faalt er één, dan blijft de rest gewoon gaan. */
async function removePrograms(list) {
  const results = [];
  for (const item of list) {
    results.push(await removeProgram(item));
  }
  return { results, removed: results.filter((r) => r.status === 'ok').length };
}

module.exports = {
  listPrograms,
  removeProgram,
  removePrograms,
  moveToTrash,
  parseDesktopFile,
  binaryFromExec,
  isSafeToRemove,
  formatSize,
  TRASH_DIR,
};
