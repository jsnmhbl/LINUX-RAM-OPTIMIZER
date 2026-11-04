'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** Voer een commando uit zonder shell (geen string-interpolatie, geen injectie). */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
/* Adressen                                                             */
/* ------------------------------------------------------------------ */

/** Haal host en poort uit een ss-adres (`127.0.0.1:80`, `[::1]:80`, `*:22`). */
function splitHostPort(value) {
  const raw = String(value ?? '').trim();
  const cut = raw.lastIndexOf(':');
  if (cut === -1) return { host: raw, port: 0 };

  let host = raw.slice(0, cut);
  const port = Number.parseInt(raw.slice(cut + 1), 10);

  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const pct = host.indexOf('%');
  if (pct !== -1) host = host.slice(0, pct);

  return { host: host || '*', port: Number.isFinite(port) ? port : 0 };
}

/**
 * Waar luistert de poort op?
 * - localhost: alleen vanaf deze machine bereikbaar
 * - exposed:   op alle netwerkinterfaces, dus ook vanaf andere machines
 * - lan:       alleen op een specifiek lokaal IP (bijv. 192.168.1.20)
 */
function classifyScope(host) {
  const value = String(host ?? '').toLowerCase();
  if (value === '*' || value === '0.0.0.0' || value === '::' || value === '::ffff:0.0.0.0') {
    return 'exposed';
  }
  if (value === 'localhost' || value === '::1' || value.startsWith('127.')) return 'localhost';
  if (value.startsWith('224.') || value.startsWith('ff')) return 'multicast';
  return 'lan';
}

/* ------------------------------------------------------------------ */
/* Proces-koppeling                                                     */
/* ------------------------------------------------------------------ */

/**
 * Koppel socket-inodes aan eigen processen.
 * `ss` toont alleen de processen die je mag zien; voor de rest (diensten van
 * het systeem) valt de cgroup terug als hint.
 */
async function inodeToProcess() {
  const map = new Map();
  let entries = [];
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let comm = '';
    try {
      comm = (await fsp.readFile(`/proc/${entry}/comm`, 'utf8')).trim();
    } catch {
      comm = '';
    }
    let fds = [];
    try {
      fds = await fsp.readdir(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = '';
      try {
        link = await fsp.readlink(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m && !map.has(m[1])) {
        map.set(m[1], { pid: Number(entry), name: comm });
      }
    }
  }
  return map;
}

/** Haal de systemd-unit uit een cgroup-string. */
function unitFromCgroup(cgroup) {
  if (!cgroup) return null;
  const m = cgroup.match(/([^/]+\.(?:service|timer|socket|scope|target))(?:\/|$)/);
  return m ? m[1] : null;
}

const PROCESS_RE = /\("([^"]+)",pid=(\d+)(?:,fd=(\d+))?\)/g;

function parseProcesses(tail) {
  const found = [];
  let m;
  PROCESS_RE.lastIndex = 0;
  while ((m = PROCESS_RE.exec(tail)) !== null) {
    found.push({ name: m[1], pid: Number(m[2]) });
  }
  return found;
}

function parseCgroup(tail) {
  const m = tail.match(/cgroup:(\S+)/);
  return m ? m[1] : null;
}

function parseInode(tail) {
  const m = tail.match(/\bino:(\d+)/);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */
/* /proc-net fallback                                                   */
/* ------------------------------------------------------------------ */

const TCP_LISTEN = '0A';

function hexToIpv4(hex) {
  const n = hex.length === 8 ? hex.match(/../g).reverse().join('') : hex;
  const bytes = n.match(/../g) || [];
  return bytes.map((b) => Number.parseInt(b, 16)).join('.');
}

function hexToIpv6(hex) {
  const groups = [];
  for (let i = 0; i < hex.length; i += 8) {
    const word = hex.slice(i, i + 8).match(/../g).reverse().join('');
    groups.push(word.toLowerCase());
  }
  return groups.join(':');
}

/** Lees /proc/net/tcp{,6} en /proc/net/udp{,6} voor luisterende sockets. */
async function collectFromProc() {
  const files = [
    { file: '/proc/net/tcp', proto: 'tcp', v6: false },
    { file: '/proc/net/tcp6', proto: 'tcp', v6: true },
    { file: '/proc/net/udp', proto: 'udp', v6: false },
    { file: '/proc/net/udp6', proto: 'udp', v6: true },
  ];

  const rows = [];
  for (const entry of files) {
    let content = '';
    try {
      content = await fsp.readFile(entry.file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const [localAddr, localPort] = parts[1].split(':');
      const state = parts[3];
      const inode = parts[9];
      if (entry.proto === 'tcp' && state !== TCP_LISTEN) continue;
      const host = entry.v6 ? hexToIpv6(localAddr) : hexToIpv4(localAddr);
      rows.push({
        proto: entry.proto,
        state: entry.proto === 'tcp' ? 'LISTEN' : 'UNCONN',
        host,
        port: Number.parseInt(localPort, 16),
        inode,
        cgroup: null,
        processes: [],
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Hoofdscan                                                            */
/* ------------------------------------------------------------------ */

/** Parseer de uitvoer van `ss -H -tulnpe`. */
function parseSs(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    const [netid, state, , , local, peer, ...rest] = parts;
    if (!['tcp', 'udp', 'udplite'].includes(netid)) continue;

    const { host, port } = splitHostPort(local);
    const tail = rest.join(' ');
    rows.push({
      proto: netid,
      state,
      host,
      port,
      peer: peer ?? '',
      inode: parseInode(tail),
      cgroup: parseCgroup(tail),
      processes: parseProcesses(tail),
    });
  }
  return rows;
}

function dedupeKey(row) {
  return `${row.proto}|${row.host}|${row.port}`;
}

/**
 * Alle open (luisterende) poorten op deze machine.
 * `exposed` poorten zijn ook vanaf andere machines bereikbaar.
 */
async function listPorts() {
  const { stdout } = await run('ss', ['-H', '-tulnpe']);
  let rows = stdout.trim() ? parseSs(stdout) : [];
  let source = 'ss';

  if (!rows.length) {
    rows = await collectFromProc();
    source = 'proc';
  }

  const procMap = await inodeToProcess();
  const seen = new Set();
  const ports = [];

  for (const row of rows) {
    const key = dedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);

    let processes = row.processes;
    if (!processes.length && row.inode && procMap.has(row.inode)) {
      const own = procMap.get(row.inode);
      processes = [{ name: own.name, pid: own.pid }];
    }

    const unit = unitFromCgroup(row.cgroup);
    const primary = processes[0] ?? null;

    ports.push({
      proto: row.proto,
      state: row.state,
      port: row.port,
      host: row.host,
      address: `${row.host}:${row.port}`,
      scope: classifyScope(row.host),
      process: primary ? primary.name : unit ? unit.replace(/\.(service|timer|socket)$/, '') : null,
      pid: primary ? primary.pid : null,
      unit: unit,
      systemOwned: !primary,
      processes: processes.map((p) => p.name),
    });
  }

  const rank = { exposed: 0, lan: 1, localhost: 2, multicast: 3 };
  ports.sort((a, b) => {
    const diff = (rank[a.scope] ?? 9) - (rank[b.scope] ?? 9);
    if (diff !== 0) return diff;
    if (a.port !== b.port) return a.port - b.port;
    return a.host.localeCompare(b.host);
  });

  return {
    source,
    ports,
    summary: {
      total: ports.length,
      exposed: ports.filter((p) => p.scope === 'exposed').length,
      localhost: ports.filter((p) => p.scope === 'localhost').length,
      lan: ports.filter((p) => p.scope === 'lan').length,
      withProcess: ports.filter((p) => p.process).length,
    },
    at: Date.now(),
  };
}

/** Processen die een bepaalde poort open hebben (of de hele lijst). */
async function findByPort(port) {
  const { ports } = await listPorts();
  return ports.filter((p) => p.port === Number(port));
}

module.exports = {
  listPorts,
  findByPort,
  classifyScope,
  splitHostPort,
};
