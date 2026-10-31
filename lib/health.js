// Vigia da VPS: o Cofre divide a máquina com os apps de venda, então ele se mede
// e FREIA sozinho antes de atrapalhar (disco, memória, processador e os apps respondendo).
import fs from 'node:fs';
import os from 'node:os';

const DATA_DIR = process.env.DATA_DIR || './data';
const GB = 1024 ** 3;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const LIMITS = {
  diskLocalGB: num(process.env.HEALTH_DISK_LOCAL_GB, 40), // abaixo disso: só "Direto pro Bunny"
  diskStopGB: num(process.env.HEALTH_DISK_STOP_GB, 20), // abaixo disso: pausa tudo
  memPct: num(process.env.HEALTH_MEM_PCT, 85), // acima disso: 1 download por vez, sem legendas e sem navegador
  cpuPct: num(process.env.HEALTH_CPU_PCT, 90), // acima disso por cpuMin minutos: pausa a fila
  cpuMin: num(process.env.HEALTH_CPU_MIN, 5),
  appSlowMs: num(process.env.HEALTH_APP_SLOW_MS, 4000),
};
// Apps vigiados: "Nome=url,Nome=url". Vazio desliga.
const APPS = (process.env.HEALTH_URLS ?? 'Meu app=https://app.membrosvips.com/health,App do Iago=https://m.membrosvips.com/health')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf('='); return i > 0 ? { name: s.slice(0, i).trim(), url: s.slice(i + 1).trim() } : { name: s, url: s }; });
const SAMPLE_MS = num(process.env.HEALTH_SAMPLE_SEC, 15) * 1000;
const APP_MS = num(process.env.HEALTH_APP_SEC, 60) * 1000;

export const health = {
  at: null,
  disk: null, // { free, total }
  mem: null, // { total, avail, pct, cofre }
  cpu: null, // { pct, cores, load }
  apps: APPS.map((a) => ({ ...a, ok: null, ms: null, status: null, fails: 0, at: null })),
  brake: { level: 'ok', reasons: [], albums: Infinity, tags: true, browser: true, uploads: true, storeLocal: true },
  limits: LIMITS,
};

// ---------- Medições ----------
function readDisk() {
  try { const s = fs.statfsSync(DATA_DIR); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; }
}
function readMem() {
  let total = os.totalmem(), avail = os.freemem();
  try { // MemAvailable conta o cache que o Linux devolve na hora (o "livre" de verdade)
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number((m.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]) * 1024;
    if (get('MemTotal')) total = get('MemTotal');
    if (get('MemAvailable')) avail = get('MemAvailable');
  } catch { /* não é Linux */ }
  let cofre = process.memoryUsage().rss;
  for (const f of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try { cofre = Number(fs.readFileSync(f, 'utf8').trim()) || cofre; break; } catch { /* sem cgroup */ }
  }
  return { total, avail, pct: Math.round(((total - avail) / total) * 100), cofre };
}
let lastStat = null;
function readCpu() {
  const cores = os.cpus().length || 1;
  const load = os.loadavg()[0];
  let pct = null;
  try { // % real da máquina toda, pela diferença entre duas leituras de /proc/stat
    const v = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0), total = v.reduce((a, b) => a + b, 0);
    if (lastStat && total > lastStat.total) pct = Math.round((1 - (idle - lastStat.idle) / (total - lastStat.total)) * 100);
    lastStat = { idle, total };
  } catch { pct = Math.min(100, Math.round((load / cores) * 100)); } // fora do Linux: aproxima pela carga
  return { pct, cores, load: Math.round(load * 100) / 100 };
}

async function checkApp(a) {
  const t = Date.now();
  try {
    const res = await fetch(a.url, { signal: AbortSignal.timeout(10e3), headers: { 'User-Agent': 'Cofre-vigia/1' } });
    await res.arrayBuffer();
    a.ms = Date.now() - t;
    a.status = res.status;
    a.ok = res.ok && a.ms < LIMITS.appSlowMs;
  } catch (e) {
    a.ms = null; a.status = String(e.name === 'TimeoutError' ? 'sem resposta' : e.message || e).slice(0, 80); a.ok = false;
  }
  a.fails = a.ok ? 0 : a.fails + 1;
  a.at = new Date().toISOString();
}

// ---------- Freio ----------
let cpuHighSince = null;
const listeners = new Set();
/** Avisa (fila de download, de envio e de legendas) quando o freio afrouxa, para retomarem. */
export const onRelease = (fn) => listeners.add(fn);

function decide() {
  const r = [];
  const b = { albums: Infinity, tags: true, browser: true, uploads: true, storeLocal: true };
  const gb = (x) => `${Math.round(x / GB)} GB`;
  if (health.disk) {
    if (health.disk.free < LIMITS.diskStopGB * GB) {
      Object.assign(b, { albums: 0, tags: false, storeLocal: false });
      r.push(`disco da VPS com só ${gb(health.disk.free)} livres — tudo pausado`);
    } else if (health.disk.free < LIMITS.diskLocalGB * GB) {
      b.storeLocal = false;
      r.push(`disco da VPS com ${gb(health.disk.free)} livres — só "Direto pro Bunny"`);
    }
  }
  if (health.mem && health.mem.pct >= LIMITS.memPct) {
    Object.assign(b, { albums: Math.min(b.albums, 1), tags: false, browser: false });
    r.push(`memória da VPS em ${health.mem.pct}% — 1 download por vez, legendas pausadas`);
  }
  if (health.cpu?.pct != null && health.cpu.pct >= LIMITS.cpuPct) {
    cpuHighSince ||= Date.now();
    if (Date.now() - cpuHighSince >= LIMITS.cpuMin * 60e3) {
      Object.assign(b, { albums: 0, tags: false, browser: false });
      r.push(`processador da VPS em ${health.cpu.pct}% há ${LIMITS.cpuMin}+ min — fila pausada`);
    }
  } else cpuHighSince = null;
  for (const a of health.apps) {
    if (a.fails >= 2) { // 2 checagens seguidas ruins (evita pausar por 1 soluço de rede)
      Object.assign(b, { albums: 0, tags: false, browser: false, uploads: false });
      const why = typeof a.status === 'number' && a.status >= 400 ? `com erro ${a.status}`
        : a.ms ? `lento (${(a.ms / 1000).toFixed(1)} s)` : `sem resposta (${a.status})`;
      r.push(`${a.name} ${why} — Cofre pausado para não atrapalhar`);
    }
  }
  const prev = health.brake;
  const looser = b.albums > prev.albums || (b.tags && !prev.tags) || (b.uploads && !prev.uploads) || (b.browser && !prev.browser);
  health.brake = { ...b, reasons: r, level: !r.length ? 'ok' : b.albums === 0 ? 'stop' : 'warn' };
  if (r.join() !== prev.reasons.join()) console.log('[vigia]', r.length ? r.join(' | ') : 'tudo normal, freio solto');
  if (looser) for (const fn of listeners) { try { fn(); } catch { /* ignora */ } }
}

function sample() {
  health.disk = readDisk();
  health.mem = readMem();
  health.cpu = readCpu();
  health.at = new Date().toISOString();
  decide();
}

export function startHealth() {
  readCpu(); // 1ª leitura de base do processador
  sample();
  setInterval(sample, SAMPLE_MS).unref();
  const apps = () => Promise.all(health.apps.map(checkApp)).then(decide);
  if (health.apps.length) { apps(); setInterval(apps, APP_MS).unref(); }
}

// Atalhos usados pelas filas
export const maxAlbums = (normal) => Math.min(normal, health.brake.albums);
export const tagsAllowed = () => health.brake.tags;
export const uploadsAllowed = () => health.brake.uploads;
export const browserAllowed = () => health.brake.browser;
export const storeLocalAllowed = () => health.brake.storeLocal;
