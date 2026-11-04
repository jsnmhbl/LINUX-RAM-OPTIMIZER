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

  tabs: $('tabs'),
  tabCountPrograms: $('tab-count-programs'),
  tabCountPorts: $('tab-count-ports'),
  tabCountAutostart: $('tab-count-autostart'),

  programList: $('program-list'),
  programsPill: $('programs-pill'),
  programsStatus: $('programs-status'),
  programSearch: $('program-search'),
  btnProgramsRefresh: $('btn-programs-refresh'),
  btnProgramsSelect: $('btn-programs-select'),
  btnProgramsRemove: $('btn-programs-remove'),

  portList: $('port-list'),
  portStats: $('port-stats'),
  portsPill: $('ports-pill'),
  portsStatus: $('ports-status'),
  portSearch: $('port-search'),
  portsExposedOnly: $('ports-exposed-only'),
  btnPortsRefresh: $('btn-ports-refresh'),

  autostartListFull: $('autostart-list-full'),
  autostartPill: $('autostart-pill'),
  autostartStatus: $('autostart-status'),
  autostartSearch: $('autostart-search'),
  autostartFilter: $('autostart-filter'),
  btnAutostartRefresh: $('btn-autostart-refresh'),
  btnAutostartDisableAll: $('btn-autostart-disable-all'),
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

const SOURCE_LABEL = {
  flatpak: 'Flatpak',
  snap: 'Snap',
  appimage: 'AppImage',
  desktop: 'App',
};

const running = { active: false };
const logLines = [];
const state = {
  programs: [],
  programSummary: {},
  ports: [],
  portSummary: {},
  autostart: [],
  autostartSummary: {},
};

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

function setStatus(element, message, cls = '') {
  element.textContent = message || '';
  element.className = `panel-status${cls ? ` ${cls}` : ''}`;
}

function badge(text, kind) {
  const span = document.createElement('span');
  span.className = `badge ${kind}`;
  span.textContent = text;
  return span;
}

function entryRow() {
  const li = document.createElement('li');
  li.className = 'entry';
  return li;
}

function entryMain(title, sub) {
  const main = document.createElement('div');
  main.className = 'entry-main';
  const titleEl = document.createElement('div');
  titleEl.className = 'entry-title';
  titleEl.textContent = title;
  main.appendChild(titleEl);
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'entry-sub';
    subEl.textContent = sub;
    main.appendChild(subEl);
  }
  return main;
}

/* -------------------------------- tabs -------------------------------- */

const loaded = { programs: false, ports: false, autostart: false };

function showTab(name) {
  for (const tab of els.tabs.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('.panel')) {
    const active = panel.dataset.panel === name;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  }
  if (name === 'programs' && !loaded.programs) loadPrograms();
  if (name === 'ports' && !loaded.ports) loadPorts();
  if (name === 'autostart' && !loaded.autostart) loadAutostart();
}

els.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  showTab(tab.dataset.tab);
});

// Ontwikkelhulp: de main-proces kan een tabblad opvragen (bv. voor screenshots).
window.ram.onShowTab((tab) => showTab(tab));

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

    const badgeEl = document.createElement('span');
    badgeEl.className = `badge ${item.disabled ? 'off' : 'on'}`;
    badgeEl.textContent = item.disabled ? 'uit' : 'aan';

    li.append(name, badgeEl);
    els.autostartList.appendChild(li);
  }
  for (const unit of scan.units) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = unit.label;
    name.title = unit.unit;

    const badgeEl = document.createElement('span');
    const off = unit.state === 'disabled' || unit.state === 'masked';
    badgeEl.className = `badge ${off ? (unit.state === 'masked' ? 'masked' : 'off') : 'on'}`;
    badgeEl.textContent = unit.state === 'masked' ? 'masked' : off ? 'uit' : 'aan';

    li.append(name, badgeEl);
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
    loaded.autostart = false;
    if (!document.querySelector('.panel[data-panel="autostart"]').hidden) loadAutostart();
  } catch (error) {
    log(`Herstel mislukt: ${error.message}`, 'err');
  } finally {
    setBusy(false);
    await refreshScan();
  }
}

/* ------------------------------ programma's --------------------------- */

function selectedPrograms() {
  return [...els.programList.querySelectorAll('.entry-check:checked')].map((input) => ({
    source: input.dataset.source,
    id: input.dataset.id,
    desktopEntries: (input.dataset.desktops || '').split(',').filter(Boolean),
  }));
}

function updateProgramButton() {
  const count = selectedPrograms().length;
  els.btnProgramsRemove.disabled = count === 0;
  els.btnProgramsRemove.textContent = count ? `Verwijderen (${count})` : 'Verwijderen';
}

function renderPrograms() {
  const term = els.programSearch.value.trim().toLowerCase();
  const list = state.programs.filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      (p.detail || '').toLowerCase().includes(term) ||
      (p.version || '').toLowerCase().includes(term)
  );

  els.programList.innerHTML = '';
  for (const program of list) {
    const li = entryRow();

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'entry-check';
    check.dataset.source = program.source;
    check.dataset.id = program.id;
    check.dataset.desktops = (program.desktopEntries || []).join(',');
    check.disabled = !program.removable;
    check.addEventListener('change', updateProgramButton);

    const sub = [program.detail, program.version ? `v${program.version}` : null].filter(Boolean).join(' · ');

    li.append(check, entryMain(program.name, sub));
    li.append(badge(SOURCE_LABEL[program.source] || program.source, program.source));

    const size = document.createElement('span');
    size.className = 'entry-size';
    size.textContent = program.formatSize || '';
    li.append(size);

    if (!program.removable) {
      li.append(badge('beschermd', 'masked'));
    }

    els.programList.appendChild(li);
  }

  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'entry entry-empty';
    empty.textContent = state.programs.length ? 'Geen programma’s gevonden.' : 'Geen programma’s gevonden.';
    els.programList.appendChild(empty);
  }

  const summary = state.programSummary;
  els.programsPill.textContent = `${summary.total || 0} gevonden · ${summary.flatpak || 0} flatpak · ${summary.snap || 0} snap · ${summary.appimage || 0} appimage`;
  els.tabCountPrograms.textContent = summary.total || '';
  updateProgramButton();
}

async function loadPrograms() {
  setStatus(els.programsStatus, 'Programma’s worden opgehaald…');
  try {
    const data = await window.ram.listPrograms();
    state.programs = data.programs;
    state.programSummary = data.summary;
    loaded.programs = true;
    renderPrograms();
    setStatus(els.programsStatus, '');
  } catch (error) {
    setStatus(els.programsStatus, `Ophalen mislukt: ${error.message}`, 'err');
  }
}

async function removeSelectedPrograms() {
  const items = selectedPrograms();
  if (!items.length) return;

  const names = items.map((item) => state.programs.find((p) => p.id === item.id)?.name || item.id);
  const needsAdmin = items.some((item) => item.source === 'snap');
  const ok = await window.ram.confirm({
    title: 'Programma’s verwijderen',
    message: `${items.length} programma’s verwijderen?`,
    detail:
      `${names.slice(0, 6).join(', ')}${names.length > 6 ? `, +${names.length - 6} meer` : ''}\n\n` +
      'Flatpak en snap worden via hun pakketbeheer verwijderd' +
      (needsAdmin ? ' — voor snap wordt om je wachtwoord gevraagd.' : '.') +
      '\nAppImage en eigen programma’s gaan naar de prullenbak, dus je kunt ze terughalen.',
  });
  if (!ok) return;

  setStatus(els.programsStatus, 'Bezig met verwijderen…');
  try {
    const result = await window.ram.removePrograms(items);
    const failed = result.results.filter((r) => r.status !== 'ok');
    if (failed.length) {
      setStatus(els.programsStatus, `${result.removed} verwijderd, ${failed.length} mislukt: ${failed[0].message}`, 'warn');
    } else {
      setStatus(els.programsStatus, `${result.removed} programma’s verwijderd.`, 'ok');
    }
    log(`${result.removed} programma’s verwijderd.`, 'ok');
    await loadPrograms();
  } catch (error) {
    setStatus(els.programsStatus, `Verwijderen mislukt: ${error.message}`, 'err');
  }
}

els.btnProgramsRemove.addEventListener('click', removeSelectedPrograms);
els.btnProgramsRefresh.addEventListener('click', () => {
  loaded.programs = false;
  loadPrograms();
});
els.btnProgramsSelect.addEventListener('click', () => {
  const checks = [...els.programList.querySelectorAll('.entry-check:not(:disabled)')];
  const allChecked = checks.every((input) => input.checked);
  for (const input of checks) input.checked = !allChecked;
  updateProgramButton();
});
els.programSearch.addEventListener('input', renderPrograms);

/* -------------------------------- poorten ----------------------------- */

function renderPorts() {
  const term = els.portSearch.value.trim().toLowerCase();
  const exposedOnly = els.portsExposedOnly.checked;
  const list = state.ports.filter((port) => {
    if (exposedOnly && port.scope !== 'exposed') return false;
    if (!term) return true;
    return (
      String(port.port).includes(term) ||
      (port.process || '').toLowerCase().includes(term) ||
      port.host.toLowerCase().includes(term)
    );
  });

  els.portList.innerHTML = '';
  for (const port of list) {
    const li = entryRow();
    const number = document.createElement('span');
    number.className = 'port-num';
    number.textContent = port.port;

    const proto = document.createElement('span');
    proto.className = 'port-proto';
    proto.textContent = port.proto;

    const sub = port.process
      ? `${port.process}${port.pid ? ` · pid ${port.pid}` : ''}`
      : port.unit
        ? `${port.unit} · systemd`
        : 'onbekend proces';

    li.append(number, proto, entryMain(port.address, sub));

    const scopeKind = port.scope === 'exposed' ? 'on' : port.scope === 'localhost' ? 'off' : 'masked';
    const scopeLabel =
      port.scope === 'exposed' ? 'exposed' : port.scope === 'localhost' ? 'lokaal' : port.scope;
    li.append(badge(scopeLabel, scopeKind));

    els.portList.appendChild(li);
  }

  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'entry entry-empty';
    empty.textContent = 'Geen poorten gevonden.';
    els.portList.appendChild(empty);
  }

  const summary = state.portSummary;
  els.portsPill.textContent = `${summary.total || 0} open`;
  els.tabCountPorts.textContent = summary.total || '';

  els.portStats.innerHTML = '';
  const stats = [
    ['Open poorten', summary.total || 0],
    ['Exposed', summary.exposed || 0],
    ['Lokaal', summary.localhost || 0],
    ['Op LAN-IP', summary.lan || 0],
    ['Process bekend', summary.withProcess || 0],
  ];
  for (const [label, value] of stats) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    li.append(span, strong);
    els.portStats.appendChild(li);
  }
}

async function loadPorts() {
  setStatus(els.portsStatus, 'Poorten worden opgehaald…');
  try {
    const data = await window.ram.listPorts();
    state.ports = data.ports;
    state.portSummary = data.summary;
    loaded.ports = true;
    renderPorts();
    setStatus(els.portsStatus, `Bron: ${data.source === 'ss' ? 'ss' : '/proc/net'} · ${data.summary.exposed} exposed`);
  } catch (error) {
    setStatus(els.portsStatus, `Ophalen mislukt: ${error.message}`, 'err');
  }
}

els.btnPortsRefresh.addEventListener('click', () => {
  loaded.ports = false;
  loadPorts();
});
els.portSearch.addEventListener('input', renderPorts);
els.portsExposedOnly.addEventListener('change', renderPorts);

/* ------------------------------ auto-start ---------------------------- */

function visibleAutostart() {
  const term = els.autostartSearch.value.trim().toLowerCase();
  const filter = els.autostartFilter.value;
  return state.autostart.filter((entry) => {
    if (term && !entry.name.toLowerCase().includes(term)) return false;
    if (filter === 'enabled' && !entry.enabled) return false;
    if (filter === 'disabled' && entry.enabled) return false;
    if (filter === 'desktop' && entry.kind !== 'desktop') return false;
    if (filter === 'unit' && entry.kind !== 'unit') return false;
    return true;
  });
}

function renderAutostartFull() {
  const list = visibleAutostart();
  els.autostartListFull.innerHTML = '';

  for (const entry of list) {
    const li = entryRow();

    const sub = [];
    if (entry.kind === 'desktop') {
      sub.push(entry.source === 'gebruiker' ? 'eigen map' : 'systeem');
      if (entry.exec) sub.push(entry.exec);
      if (entry.executableMissing) sub.push('programma ontbreekt');
    } else {
      sub.push(entry.unitType);
      if (entry.active && entry.active !== 'inactive') sub.push(`actief: ${entry.active}`);
      if (entry.nextRun) sub.push(`volgende run: ${entry.nextRun}`);
    }

    li.append(entryMain(entry.name, sub.filter(Boolean).join(' · ')));

    if (entry.kind === 'desktop') {
      li.append(badge(entry.source, entry.source === 'gebruiker' ? 'off' : 'masked'));
    } else {
      li.append(badge(entry.unitType, 'masked'));
    }

    if (entry.executableMissing) li.append(badge('verouderd', 'on'));

    const label = document.createElement('label');
    label.className = 'switch switch-sm';
    label.title = entry.enabled ? 'Staat aan — klik om uit te schakelen' : 'Staat uit — klik om aan te zetten';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = entry.enabled;
    input.disabled = Boolean(entry.protected);
    input.addEventListener('change', () => toggleAutostart(entry, input));

    const slider = document.createElement('span');
    slider.className = 'slider';

    const text = document.createElement('span');
    text.className = 'switch-label';
    text.textContent = entry.enabled ? 'aan' : 'uit';

    label.append(input, slider, text);
    li.append(label);

    els.autostartListFull.appendChild(li);
  }

  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'entry entry-empty';
    empty.textContent = 'Niets gevonden.';
    els.autostartListFull.appendChild(empty);
  }

  const summary = state.autostartSummary;
  els.autostartPill.textContent = `${summary.enabled || 0} staan aan · ${summary.disabled || 0} uit`;
  els.tabCountAutostart.textContent = summary.enabled || '';
}

async function toggleAutostart(entry, input) {
  const enabled = input.checked;
  input.disabled = true;
  setStatus(els.autostartStatus, `${entry.name} wordt ${enabled ? 'ingeschakeld' : 'uitgeschakeld'}…`);
  try {
    const result = await window.ram.setAutostart({ kind: entry.kind, id: entry.id, enabled });
    if (result.status === 'ok') {
      entry.enabled = enabled;
      setStatus(els.autostartStatus, result.message, 'ok');
      log(`${result.message}`, 'ok');
    } else {
      setStatus(els.autostartStatus, result.message || 'Mislukt', 'err');
    }
  } catch (error) {
    setStatus(els.autostartStatus, `Mislukt: ${error.message}`, 'err');
  } finally {
    input.disabled = Boolean(entry.protected);
    loaded.autostart = false;
    await loadAutostart();
  }
}

async function disableAllAutostart() {
  const targets = visibleAutostart().filter((entry) => entry.enabled && !entry.protected);
  if (!targets.length) {
    setStatus(els.autostartStatus, 'Niets om uit te schakelen.', 'warn');
    return;
  }
  const ok = await window.ram.confirm({
    title: 'Auto-start uitschakelen',
    message: `${targets.length} items uitschakelen?`,
    detail: 'Ze starten dan niet meer mee bij het opstarten. Met “Herstel” zet je ze terug.',
  });
  if (!ok) return;

  setStatus(els.autostartStatus, 'Bezig…');
  let done = 0;
  const failed = [];
  for (const entry of targets) {
    try {
      const result = await window.ram.setAutostart({ kind: entry.kind, id: entry.id, enabled: false });
      if (result.status === 'ok') done += 1;
      else failed.push(result.message);
    } catch (error) {
      failed.push(error.message);
    }
  }
  setStatus(
    els.autostartStatus,
    failed.length ? `${done} uitgezet, ${failed.length} mislukt: ${failed[0]}` : `${done} items uitgezet.`,
    failed.length ? 'warn' : 'ok'
  );
  log(`${done} auto-start items uitgezet.`, 'ok');
  loaded.autostart = false;
  await loadAutostart();
}

async function loadAutostart() {
  setStatus(els.autostartStatus, 'Auto-start items worden opgehaald…');
  try {
    const data = await window.ram.listAutostart();
    state.autostart = data.entries;
    state.autostartSummary = data.summary;
    loaded.autostart = true;
    renderAutostartFull();
    setStatus(els.autostartStatus, '');
  } catch (error) {
    setStatus(els.autostartStatus, `Ophalen mislukt: ${error.message}`, 'err');
  }
}

els.btnAutostartRefresh.addEventListener('click', () => {
  loaded.autostart = false;
  loadAutostart();
});
els.btnAutostartDisableAll.addEventListener('click', disableAllAutostart);
els.autostartSearch.addEventListener('input', renderAutostartFull);
els.autostartFilter.addEventListener('change', renderAutostartFull);

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
