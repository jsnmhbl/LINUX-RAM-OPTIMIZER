'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  ramPill: $('ram-pill'),
  ramUsed: $('ram-used'),
  ramTotal: $('ram-total'),
  segUsed: $('seg-used'),
  segCached: $('seg-cached'),
  segFree: $('seg-free'),
  statAvailable: $('stat-available'),
  statFree: $('stat-free'),
  statCached: $('stat-cached'),
  statSwap: $('stat-swap'),
  procList: $('proc-list'),
  btnOptimize: $('btn-optimize'),
  btnRestore: $('btn-restore'),
  btnOpenReport: $('btn-open-report'),
  autoOptimize: $('auto-optimize'),
  steps: $('steps'),
  stepsPill: $('steps-pill'),
  autostartList: $('autostart-list'),
  log: $('log'),
};

const STEP_META = [
  {
    id: 'chrome',
    label: 'Chrome stoppen + Memory Saver',
    desc: 'Sluit de browser, bewaar de sessie en laat inactieve tabbladen slapen.',
    impact: '~5 GB',
  },
  {
    id: 'zapzap',
    label: 'ZapZap stoppen',
    desc: 'QtWebEngine lekt ~45 MB per minuut tot 1,3 GB per renderer.',
    impact: '~2 GB',
  },
  {
    id: 'services',
    label: 'OpenClaw Gateway stoppen',
    desc: 'Zware achtergronddienst (1,2 GB) die geen client verbonden heeft.',
    impact: '~1,2 GB',
  },
  {
    id: 'autostart',
    label: 'Auto-start uitschakelen',
    desc: 'Apps en update-timers die bij het opstarten vanzelf meelopen.',
    impact: 'starttijd',
  },
  {
    id: 'swap',
    label: 'Swap opruimen',
    desc: 'Haalt oude, koude pagina’s terug uit zram. Vraagt om je wachtwoord.',
    impact: '~3 GB',
  },
];

const running = { active: false };
const logLines = [];

/* ------------------------------- hulpjes ------------------------------- */

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function log(line, cls = '') {
  logLines.push({ line, cls });
  if (logLines.length > 400) logLines.shift();
  renderLog();
}

function renderLog() {
  els.log.textContent = logLines.map((entry) => entry.line).join('\n');
  els.log.scrollTop = els.log.scrollHeight;
}

function paintLog() {
  els.log.innerHTML = '';
  for (const entry of logLines) {
    const span = document.createElement('span');
    if (entry.cls) span.className = entry.cls;
    span.textContent = entry.line + '\n';
    els.log.appendChild(span);
  }
  els.log.scrollTop = els.log.scrollHeight;
}

/* -------------------------------- scan -------------------------------- */

function renderMemory(memory) {
  const usedPct = memory.total ? (memory.used / memory.total) * 100 : 0;
  const cachedPct = memory.total ? (memory.cached / memory.total) * 100 : 0;
  const freePct = Math.max(0, 100 - usedPct - cachedPct);

  els.ramUsed.textContent = formatBytes(memory.used);
  els.ramTotal.textContent = formatBytes(memory.total);
  els.segUsed.style.width = `${usedPct}%`;
  els.segCached.style.width = `${cachedPct}%`;
  els.segFree.style.width = `${freePct}%`;

  els.statAvailable.textContent = formatBytes(memory.available);
  els.statFree.textContent = formatBytes(memory.free);
  els.statCached.textContent = formatBytes(memory.cached);
  els.statSwap.textContent = `${formatBytes(memory.swapUsed).replace(' GiB', '')} / ${formatBytes(memory.swapTotal).replace(' GiB', '')} GiB`;

  const level = memory.percent > 90 ? 'hoog' : memory.percent > 75 ? 'gemiddeld' : 'laag';
  els.ramPill.textContent = `${memory.percent}% · ${level}`;
}

function renderSteps(state = {}) {
  els.steps.innerHTML = '';
  for (const step of STEP_META) {
    const li = document.createElement('li');
    li.className = 'step';
    if (state.running === step.id) li.classList.add('is-running');
    if (state.statuses?.[step.id] && state.statuses[step.id] !== 'ok') {
      li.classList.add('is-disabled');
    }

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'step-check';
    check.dataset.stepId = step.id;
    check.checked = state.selected ? state.selected.includes(step.id) : true;
    check.disabled = running.active;
    check.addEventListener('change', persistSelection);

    const title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = step.label;

    const desc = document.createElement('div');
    desc.className = 'step-desc';
    desc.textContent = step.desc;

    const impact = document.createElement('div');
    impact.className = 'step-impact';
    impact.textContent = step.impact;

    const status = document.createElement('div');
    status.className = 'step-status';
    if (state.statuses?.[step.id]) {
      status.classList.add(state.statuses[step.id]);
      status.textContent = state.messages?.[step.id] || state.statuses[step.id];
    }

    li.append(check, title, impact, desc, status);
    els.steps.appendChild(li);
  }
  const count = state.selected ? state.selected.length : STEP_META.length;
  els.stepsPill.textContent = `${count}/${STEP_META.length} geselecteerd`;
}

function renderAutostart(scan) {
  els.autostartList.innerHTML = '';
  for (const item of scan.autostart) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.label;
    name.title = `${item.file} (${item.source})`;

    const badge = document.createElement('span');
    badge.className = `badge ${item.disabled ? 'off' : 'on'}`;
    badge.textContent = item.disabled ? 'uit' : 'aan';

    li.append(name, badge);
    els.autostartList.appendChild(li);
  }
  for (const unit of scan.units) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = unit.label;
    name.title = unit.unit;

    const badge = document.createElement('span');
    const off = unit.state === 'disabled' || unit.state === 'masked';
    badge.className = `badge ${off ? (unit.state === 'masked' ? 'masked' : 'off') : 'on'}`;
    badge.textContent = unit.state === 'masked' ? 'masked' : off ? 'uit' : 'aan';

    li.append(name, badge);
    els.autostartList.appendChild(li);
  }
}

function renderProcesses(processes) {
  els.procList.innerHTML = '';
  for (const proc of processes.slice(0, 6)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = proc.name;
    name.title = `pid ${proc.pid}`;

    const mem = document.createElement('span');
    mem.className = 'pmem';
    mem.textContent = formatBytes(proc.rss);

    li.append(name, mem);
    els.procList.appendChild(li);
  }
}

async function refreshScan() {
  const scan = await window.ram.scan();
  renderMemory(scan.memory);
  renderAutostart(scan);
  renderProcesses(scan.processes);
  return scan;
}

/* ----------------------------- instellingen ---------------------------- */

function selectedSteps() {
  return [...document.querySelectorAll('.step-check')]
    .filter((input) => input.checked)
    .map((input) => input.dataset.stepId);
}

function persistSelection() {
  const steps = selectedSteps();
  window.ram.setSettings({ steps });
  renderSteps({ selected: steps });
}

/* ------------------------------ optimaliseren -------------------------- */

function setBusy(busy) {
  running.active = busy;
  els.btnOptimize.disabled = busy;
  els.btnRestore.disabled = busy;
  els.btnOptimize.classList.toggle('running', busy);
  els.btnOptimize.querySelector('.btn-label').textContent = busy ? 'Bezig…' : 'Optimaliseer nu';
  els.btnOptimize.querySelector('.btn-hint').textContent = busy
    ? 'Even geduld, dit duurt een paar seconden'
    : 'Start met de knop — alles draait in één keer';
  document.querySelectorAll('.step-check').forEach((input) => {
    input.disabled = busy;
  });
}

async function runOptimize() {
  if (running.active) return;

  const steps = selectedSteps();
  const needsSwap = steps.includes('swap');
  if (needsSwap) {
    const ok = await window.ram.confirm({
      title: 'Swap opruimen',
      message: 'Voor het opruimen van de swap wordt om je wachtwoord gevraagd.',
      detail: 'Er verschijnt een systeemvenster van de administrator. Kies daarna je wachtwoord.',
    });
    if (!ok) {
      steps.splice(steps.indexOf('swap'), 1);
      log('Stap “Swap opruimen” overgeslagen op jouw verzoek.', 'warn');
    }
  }

  setBusy(true);
  log('');
  log('— Optimalisatie gestart —', 'accent');
  const statuses = {};
  const messages = {};

  const off = window.ram.onOptimizeEvent((event) => {
    if (event.type === 'log') {
      log(event.line);
    } else if (event.type === 'step-start') {
      statuses[event.id] = 'running';
      messages[event.id] = 'bezig…';
      renderSteps({ selected: steps, statuses, messages });
      log(`▸ ${event.label}`, 'accent');
    } else if (event.type === 'step') {
      statuses[event.result.id] = event.result.status;
      messages[event.result.id] = event.result.message;
      renderSteps({ selected: steps, statuses, messages });
      const mark = { ok: '✓', warn: '!', error: '×', skipped: '–' }[event.result.status] || '·';
      const cls = { ok: 'ok', warn: 'warn', error: 'err', skipped: '' }[event.result.status] || '';
      log(`  ${mark} ${event.result.label} — ${event.result.message}`, cls);
    } else if (event.type === 'phase' && event.phase === 'before') {
      renderMemory(event.memory);
      log(`Start: ${formatBytes(event.memory.used)} in gebruik, ${formatBytes(event.memory.available)} beschikbaar.`);
    }
  });

  try {
    const report = await window.ram.optimize(steps);
    renderMemory(report.after);
    const freed = report.before.used - report.after.used;
    log('');
    log(
      `Klaar — ${freed > 0 ? `${formatBytes(freed)} vrijgemaakt` : 'geen verdere winst'}. ` +
        `Nu ${formatBytes(report.after.used)} in gebruik, ${formatBytes(report.after.available)} beschikbaar.`,
      freed > 0 ? 'ok' : ''
    );
  } catch (error) {
    log(`Er ging iets mis: ${error.message}`, 'err');
  } finally {
    off?.();
    setBusy(false);
    await refreshScan();
  }
}

async function runRestore() {
  if (running.active) return;
  const ok = await window.ram.confirm({
    title: 'Alles terugzetten',
    message: 'Zet alle uitgeschakelde auto-start items en diensten terug.',
    detail: 'Chrome-instellingen worden teruggezet naar de originele back-up.',
  });
  if (!ok) return;

  setBusy(true);
  log('');
  log('— Herstel gestart —', 'accent');
  try {
    const result = await window.ram.restore();
    for (const item of result.results) {
      log(`  ✓ ${item.label} — ${item.message}`, item.status === 'ok' ? 'ok' : 'warn');
    }
    log('Herstel voltooid.', 'ok');
  } catch (error) {
    log(`Herstel mislukt: ${error.message}`, 'err');
  } finally {
    setBusy(false);
    await refreshScan();
  }
}

/* --------------------------------- start ------------------------------ */

els.btnOptimize.addEventListener('click', runOptimize);
els.btnRestore.addEventListener('click', runRestore);
els.btnOpenReport.addEventListener('click', () => window.ram.openReportFolder());

els.autoOptimize.addEventListener('change', () => {
  window.ram.setSettings({ autoOptimize: els.autoOptimize.checked });
  log(
    els.autoOptimize.checked
      ? 'Auto-run ingeschakeld: de volgende keer wordt direct geoptimaliseerd.'
      : 'Auto-run uitgeschakeld.',
    'accent'
  );
});

(async function init() {
  const settings = await window.ram.getSettings();
  els.autoOptimize.checked = Boolean(settings.autoOptimize);
  renderSteps({ selected: settings.steps?.length ? settings.steps : STEP_META.map((s) => s.id) });
  await refreshScan();

  setInterval(() => {
    if (!running.active) refreshScan().catch(() => {});
  }, 4000);

  if (settings.autoOptimize) {
    log('Auto-run staat aan: optimalisatie start automatisch.', 'accent');
    await new Promise((r) => setTimeout(r, 600));
    runOptimize();
  }
})();
