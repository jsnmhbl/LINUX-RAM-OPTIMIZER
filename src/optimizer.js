'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const CHROME_DIR = path.join(HOME, '.config', 'google-chrome');
const CHROME_PREFS = path.join(CHROME_DIR, 'Default', 'Preferences');
const CHROME_LOCAL_STATE = path.join(CHROME_DIR, 'Local State');
const AUTOSTART_DIR = path.join(HOME, '.config', 'autostart');
const AUTOSTART_BACKUP = path.join(AUTOSTART_DIR, 'disabled-by-ram-opt');
const USER_UNIT_DIR = path.join(HOME, '.config', 'systemd', 'user');
const DISABLED_SERVICES_DIR = path.join(USER_UNIT_DIR, 'disabled-services');
const REPORT_DIR = path.join(HOME, '.local', 'state', 'ram-optimizer');

/** Voer een commando uit zonder shell (geen string-interpolatie, geen injectie). */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

/** Vind alle pids van een procesnaam (zoals `pgrep -x`, maar zonder shell). */
async function pidsOf(name) {
  const { stdout } = await run('pgrep', ['-x', name]);
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
}

function killPids(pids, signal = 'SIGKILL') {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* al weg */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Systeemstatus                                                      */
/* ------------------------------------------------------------------ */

async function readMemory() {
  const raw = await fsp.readFile('/proc/meminfo', 'utf8');
  const kb = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  const free = kb('MemFree');
  const cached = kb('Cached') + kb('SReclaimable');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    total,
    used: total - available,
    available,
    free,
    cached,
    swapTotal,
    swapUsed: swapTotal - swapFree,
    percent: total ? Math.round(((total - available) / total) * 100) : 0,
  };
}

async function topProcesses(limit = 8) {
  const { stdout } = await run('ps', ['-eo', 'pid,rss,comm', '--sort=-rss']);
  const rows = stdout
    .split('\n')
    .slice(1)
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return { pid: Number(m[1]), rss: Number(m[2]) * 1024, name: m[3] };
    })
    .filter(Boolean)
    .slice(0, limit);
  return rows;
}

async function isRunning(name) {
  return (await pidsOf(name)).length > 0;
}

async function unitEnabled(unit) {
  const { stdout } = await run('systemctl', ['--user', 'is-enabled', unit]);
  const value = stdout.trim();
  if (!value) return 'unknown';
  if (value.includes('masked')) return 'masked';
  if (value.includes('disabled')) return 'disabled';
  if (value.includes('enabled')) return 'enabled';
  return value;
}

async function unitActive(unit) {
  const { stdout } = await run('systemctl', ['--user', 'is-active', unit]);
  return stdout.trim() || 'unknown';
}

/* ------------------------------------------------------------------ */
/* Instellingen die de app uitschakelt                                  */
/* ------------------------------------------------------------------ */

const DESKTOP_APPS = [
  { file: 'Clips.desktop', label: 'Clips' },
  { file: 'work-louder-input.desktop', label: 'Work Louder Input' },
  { file: 'vibevoice-autostart.desktop', label: 'VibeVoice' },
  { file: 'tracker-miner-fs-3.desktop', label: 'Tracker (file-indexer)' },
  { file: 'print-applet.desktop', label: 'Print Queue Applet' },
  { file: 'nm-applet.desktop', label: 'NetworkManager Applet' },
  { file: 'pop-app-folders.desktop', label: 'Pop App Folders' },
];

const TIMERS = [
  { unit: 'pop-upgrade-notify.timer', label: 'Pop! upgrade-notificatie' },
  { unit: 'launchpadlib-cache-clean.timer', label: 'Launchpad cache-clean' },
  { unit: 'pc-flatpak-updates.timer', label: 'Pop! Flatpak update-check' },
  { unit: 'pc-post-update-check.timer', label: 'Post-update check' },
  { unit: 'lvro-shopping-source-refresh.timer', label: 'LVRO shopping source' },
];

const SERVICES = [
  { unit: 'openclaw-gateway.service', label: 'OpenClaw Gateway', stop: true, disable: true },
];

const MEMORY_SAVER_STATE = 2; // 0=uit, 1=maximum, 2=balanced, 3=moderate

/* ------------------------------------------------------------------ */
/* Stappen                                                             */
/* ------------------------------------------------------------------ */

/**
 * Chrome: Memory Saver aanzetten, sessie-herstel bewaken en de browser
 * stoppen zonder de crash-restore-lus opnieuw te triggeren.
 */
async function optimizeChrome(log) {
  const result = { status: 'ok', message: '' };

  if (!fs.existsSync(CHROME_PREFS)) {
    return { status: 'skipped', message: 'Geen Chrome-profiel gevonden' };
  }

  const wasRunning = (await pidsOf('chrome')).length > 0;

  // 1. Back-ups maken (eenmalig) zodat alles terug kan.
  await fsp.mkdir(AUTOSTART_BACKUP, { recursive: true });
  for (const file of [CHROME_PREFS, CHROME_LOCAL_STATE]) {
    const backup = `${file}.bak-ram-opt`;
    if (fs.existsSync(file) && !fs.existsSync(backup)) {
      await fsp.copyFile(file, backup);
    }
  }

  // 2. Prefs schrijven: Memory Saver aan, sessie-herstel aan, geen crash-markering.
  const writeChromePrefs = async (exitType) => {
    const prefs = readJson(CHROME_PREFS);
    if (prefs) {
      prefs.profile = prefs.profile || {};
      prefs.profile.exit_type = exitType;
      prefs.profile.exited_cleanly = true;
      prefs.session = prefs.session || {};
      prefs.session.restore_on_startup = 1; // vorige sessie herstellen bij herstart
      delete prefs.memory_saver_mode;
      delete prefs.tab_sleeping;
      writeJson(CHROME_PREFS, prefs);
    }
    const local = readJson(CHROME_LOCAL_STATE);
    if (local) {
      local.performance_tuning = local.performance_tuning || {};
      local.performance_tuning.high_efficiency_mode = local.performance_tuning.high_efficiency_mode || {};
      local.performance_tuning.high_efficiency_mode.state = MEMORY_SAVER_STATE;
      delete local.memory_saver_mode;
      delete local.tab_sleeping;
      writeJson(CHROME_LOCAL_STATE, local);
    }
  };

  await writeChromePrefs('Normal');

  if (!wasRunning) {
    result.message = 'Chrome stond al uit — Memory Saver staat aan';
    return result;
  }

  // 3. Chrome stoppen. Chrome herstart zichzelf na een onzuivere exit, dus we
  //    herhalen: alles doden -> crash-markering resetten -> wachten tot het rustig is.
  for (let round = 0; round < 6; round += 1) {
    const pids = await pidsOf('chrome');
    if (pids.length === 0) break;

    // Eerst netjes stoppen zodat de sessie wordt bewaard.
    if (round === 0) {
      const main = pids.find((pid) => {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          return cmd.length === 1 && cmd[0] === '/opt/google/chrome/chrome';
        } catch {
          return false;
        }
      });
      if (main) {
        try {
          process.kill(main, 'SIGTERM');
        } catch {
          /* al weg */
        }
        await sleep(3000);
      }
    }

    killPids(await pidsOf('chrome'), 'SIGKILL');
    await writeChromePrefs('Normal');
    await sleep(2000);
    log(`  Chrome ronde ${round + 1}: ${(await pidsOf('chrome')).length} processen over`);
  }

  const left = (await pidsOf('chrome')).length;
  if (left > 0) {
    return { status: 'warn', message: `${left} Chrome-processen konden niet gestopt worden` };
  }
  result.message = 'Gestopt — tabbladen komen terug bij herstart, Memory Saver staat aan';
  return result;
}

async function optimizeZapZap(log) {
  const pids = await pidsOf('zapzap');
  const qt = await run('pgrep', ['-f', 'QtWebEngineProcess']);
  const qtPids = qt.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);

  if (pids.length === 0 && qtPids.length === 0) {
    return { status: 'skipped', message: 'ZapZap stond al uit' };
  }

  // ZapZap lekt geheugen in zijn QtWebEngine-renderer; dus niet herstarten maar stoppen.
  killPids(qtPids, 'SIGTERM');
  killPids(pids, 'SIGTERM');
  await sleep(2500);
  killPids(await pidsOf('zapzap'), 'SIGKILL');
  killPids(await run('pgrep', ['-f', 'QtWebEngineProcess']).stdout
    .split('\n').map((s) => s.trim()).filter(Boolean).map(Number), 'SIGKILL');
  await sleep(1000);

  const left = (await pidsOf('zapzap')).length;
  log(`  ZapZap: ${left} processen over`);
  return {
    status: left === 0 ? 'ok' : 'warn',
    message: left === 0 ? 'Gestopt (leek ~45 MB/min aan geheugen)' : `${left} processen bleven hangen`,
  };
}

async function optimizeServices(log) {
  const changed = [];
  const failed = [];
  for (const service of SERVICES) {
    const state = await unitEnabled(service.unit);
    if (state === 'enabled') {
      const r = await run('systemctl', ['--user', 'disable', service.unit]);
      if (r.code === 0) changed.push(service.label);
      else failed.push(`${service.label} (${r.stderr.trim() || 'disable mislukt'})`);
    }
    if (service.stop) {
      await run('systemctl', ['--user', 'stop', service.unit]);
    }
  }
  if (failed.length) return { status: 'warn', message: failed.join(', ') };
  if (!changed.length) return { status: 'ok', message: 'OpenClaw Gateway stond al uit' };
  log(`  Uitgeschakeld: ${changed.join(', ')}`);
  return { status: 'ok', message: `Uitgeschakeld en gestopt: ${changed.join(', ')}` };
}

async function optimizeAutostartApps(log) {
  const disabled = [];
  const restored = [];
  await fsp.mkdir(AUTOSTART_BACKUP, { recursive: true });

  for (const app of DESKTOP_APPS) {
    const userFile = path.join(AUTOSTART_DIR, app.file);
    const systemFile = path.join('/etc/xdg/autostart', app.file);

    if (fs.existsSync(userFile)) {
      const content = fs.readFileSync(userFile, 'utf8');
      if (!/^Hidden=true$/m.test(content)) {
        const backup = path.join(AUTOSTART_BACKUP, `${app.file}.orig`);
        if (!fs.existsSync(backup)) await fsp.copyFile(userFile, backup);
        const updated = content
          .replace(/^Hidden=.*$/m, '')
          .replace(/^X-GNOME-Autostart-enabled=.*$/m, '')
          .replace('[Desktop Entry]', '[Desktop Entry]\nHidden=true\nX-GNOME-Autostart-enabled=false');
        await fsp.writeFile(userFile, updated);
        disabled.push(app.label);
      }
    } else if (fs.existsSync(systemFile)) {
      // Systeem-entry overschrijven met een shadow-bestand in de eigen map.
      const content = fs.readFileSync(systemFile, 'utf8');
      if (!/^Hidden=true$/m.test(content)) {
        const updated = content
          .replace(/^Hidden=.*$/m, '')
          .replace(/^X-GNOME-Autostart-enabled=.*$/m, '')
          .replace('[Desktop Entry]', '[Desktop Entry]\nHidden=true\nX-GNOME-Autostart-enabled=false');
        await fsp.writeFile(userFile, updated);
        disabled.push(app.label);
      }
    }
  }

  // Actieve autostart-sessies van die apps stoppen.
  for (const unit of [
    'app-Clips@autostart.service',
    'app-work\\x2dlouder\\x2dinput@autostart.service',
    'app-print\\x2dapplet@autostart.service',
  ]) {
    await run('systemctl', ['--user', 'stop', unit]);
  }

  for (const timer of TIMERS) {
    const state = await unitEnabled(timer.unit);
    if (state !== 'disabled' && state !== 'masked') {
      const r = await run('systemctl', ['--user', 'disable', '--now', timer.unit]);
      if (r.code === 0) {
        await run('systemctl', ['--user', 'mask', timer.unit]);
        disabled.push(timer.label);
      }
    }
  }

  if (!disabled.length) return { status: 'ok', message: 'Alles stond al uit' };
  log(`  Auto-start uitgezet: ${disabled.join(', ')}`);
  return { status: 'ok', message: `${disabled.length} items uitgezet` };
}

async function resetSwap(log) {
  // Vereist root: via pkexec zodat er een echte wachtwoordvenster opent.
  const probe = await run('pkexec', ['--version']);
  if (probe.code !== 0) {
    return { status: 'skipped', message: 'pkexec niet beschikbaar' };
  }
  const script = 'swapoff -a && swapon -a';
  const r = await run('pkexec', ['/bin/sh', '-c', script], { timeout: 120000 });
  if (r.code !== 0) {
    return { status: 'warn', message: 'Geannuleerd of mislukt (wachtwoord nodig)' };
  }
  log('  Swap gereset');
  return { status: 'ok', message: 'Swap gereset — koude pagina’s zijn terug in RAM' };
}

/* ------------------------------------------------------------------ */
/* Scan                                                               */
/* ------------------------------------------------------------------ */

async function scan() {
  const memory = await readMemory();
  const processes = await topProcesses();

  const heavy = [];
  const checks = [
    { name: 'chrome', label: 'Chrome' },
    { name: 'zapzap', label: 'ZapZap' },
    { name: 'bun', label: 'OpenClaw Gateway' },
  ];
  for (const check of checks) {
    const pids = await pidsOf(check.name);
    if (pids.length) {
      let rss = 0;
      for (const pid of pids) {
        try {
          const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
          const m = status.match(/^VmRSS:\s+(\d+)/m);
          if (m) rss += Number(m[1]) * 1024;
        } catch {
          /* weg */
        }
      }
      heavy.push({ label: check.label, rss, pids: pids.length });
    }
  }

  const autostart = [];
  for (const app of DESKTOP_APPS) {
    const userFile = path.join(AUTOSTART_DIR, app.file);
    const systemFile = path.join('/etc/xdg/autostart', app.file);
    const file = fs.existsSync(userFile) ? userFile : fs.existsSync(systemFile) ? systemFile : null;
    if (!file) continue;
    const content = fs.readFileSync(file, 'utf8');
    autostart.push({
      label: app.label,
      file: app.file,
      disabled: /^Hidden=true$/m.test(content),
      source: file.startsWith(AUTOSTART_DIR) && file !== systemFile ? 'gebruiker' : 'systeem',
    });
  }

  const units = [];
  for (const timer of TIMERS) {
    units.push({ label: timer.label, unit: timer.unit, state: await unitEnabled(timer.unit) });
  }
  for (const service of SERVICES) {
    units.push({
      label: service.label,
      unit: service.unit,
      state: await unitEnabled(service.unit),
      active: await unitActive(service.unit),
    });
  }

  return { memory, processes, heavy, autostart, units, at: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Optimalisatie-run                                                   */
/* ------------------------------------------------------------------ */

const STEP_DEFINITIONS = [
  {
    id: 'chrome',
    label: 'Chrome stoppen + Memory Saver',
    description: 'Sluit de browser, bewaar de sessie en laat inactieve tabbladen slapen.',
    impact: '~5 GB',
    run: optimizeChrome,
  },
  {
    id: 'zapzap',
    label: 'ZapZap stoppen',
    description: 'QtWebEngine lekt ~45 MB per minuut tot 1,3 GB per renderer.',
    impact: '~2 GB',
    run: optimizeZapZap,
  },
  {
    id: 'services',
    label: 'OpenClaw Gateway stoppen',
    description: 'Zware achtergronddienst (1,2 GB) die geen client verbonden heeft.',
    impact: '~1,2 GB',
    run: optimizeServices,
  },
  {
    id: 'autostart',
    label: 'Auto-start uitschakelen',
    description: 'Apps en update-timers die bij het opstarten vanzelf meelopen.',
    impact: 'starttijd',
    run: optimizeAutostartApps,
  },
  {
    id: 'swap',
    label: 'Swap opruimen',
    description: 'Haalt oude, koude pagina’s terug uit zram. Vraagt om je wachtwoord.',
    impact: '~3 GB',
    needsRoot: true,
    run: resetSwap,
  },
];

async function optimize({ steps, onEvent }) {
  const logLines = [];
  const log = (line) => {
    logLines.push(line);
    onEvent?.({ type: 'log', line });
  };

  const before = await readMemory();
  onEvent?.({ type: 'phase', phase: 'before', memory: before });

  const results = [];
  for (const step of STEP_DEFINITIONS) {
    if (!steps.includes(step.id)) {
      results.push({ id: step.id, label: step.label, status: 'skipped', message: 'Overgeslagen' });
      onEvent?.({ type: 'step', result: results[results.length - 1] });
      continue;
    }

    onEvent?.({ type: 'step-start', id: step.id, label: step.label });
    try {
      const result = await step.run(log);
      results.push({ id: step.id, label: step.label, ...result });
    } catch (error) {
      results.push({ id: step.id, label: step.label, status: 'error', message: error.message });
    }
    onEvent?.({ type: 'step', result: results[results.length - 1] });
  }

  await sleep(1500);
  const after = await readMemory();
  onEvent?.({ type: 'phase', phase: 'after', memory: after });

  const report = {
    at: new Date().toISOString(),
    before,
    after,
    results,
    log: logLines,
  };
  await writeReport(report);

  return report;
}

async function writeReport(report) {
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const stamp = report.at.replace(/[:.]/g, '-');
  const file = path.join(REPORT_DIR, `rapport-${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify(report, null, 2));
  const latest = path.join(REPORT_DIR, 'laatste-rapport.json');
  await fsp.writeFile(latest, JSON.stringify(report, null, 2));
  return latest;
}

/* ------------------------------------------------------------------ */
/* Herstel                                                            */
/* ------------------------------------------------------------------ */

async function restore({ onEvent }) {
  const logLines = [];
  const log = (line) => {
    logLines.push(line);
    onEvent?.({ type: 'log', line });
  };
  const results = [];

  // Desktop-bestanden terugzetten.
  for (const app of DESKTOP_APPS) {
    const backup = path.join(AUTOSTART_BACKUP, `${app.file}.orig`);
    const target = path.join(AUTOSTART_DIR, app.file);
    if (fs.existsSync(backup)) {
      await fsp.copyFile(backup, target);
      results.push({ label: app.label, status: 'ok', message: 'Hersteld' });
    } else if (fs.existsSync(target) && fs.existsSync(path.join('/etc/xdg/autostart', app.file))) {
      await fsp.unlink(target);
      results.push({ label: app.label, status: 'ok', message: 'Shadow-bestand verwijderd' });
    }
  }

  // Units terugzetten.
  for (const timer of TIMERS) {
    await run('systemctl', ['--user', 'unmask', timer.unit]);
    const r = await run('systemctl', ['--user', 'enable', '--now', timer.unit]);
    results.push({
      label: timer.label,
      status: r.code === 0 ? 'ok' : 'warn',
      message: r.code === 0 ? 'Hersteld' : r.stderr.trim() || 'Herstel mislukt',
    });
  }
  for (const service of SERVICES) {
    const r = await run('systemctl', ['--user', 'enable', '--now', service.unit]);
    results.push({
      label: service.label,
      status: r.code === 0 ? 'ok' : 'warn',
      message: r.code === 0 ? 'Hersteld en gestart' : r.stderr.trim() || 'Herstel mislukt',
    });
  }

  // Chrome-prefs terugzetten.
  for (const file of [CHROME_PREFS, CHROME_LOCAL_STATE]) {
    const backup = `${file}.bak-ram-opt`;
    if (fs.existsSync(backup)) {
      await fsp.copyFile(backup, file);
    }
  }
  results.push({ label: 'Chrome-instellingen', status: 'ok', message: 'Teruggezet naar origine' });

  log('Herstel voltooid');
  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const latest = path.join(REPORT_DIR, 'laatste-herstel.json');
  await fsp.writeFile(latest, JSON.stringify({ at: new Date().toISOString(), results, log: logLines }, null, 2));

  return { results, log: logLines, report: latest };
}

module.exports = {
  scan,
  optimize,
  restore,
  readMemory,
  topProcesses,
  STEP_DEFINITIONS,
  REPORT_DIR,
};
