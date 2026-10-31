import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

// "Contas": cookies de login por site, enviados pelo app.
// Cada site fica em /data/cookies/<dominio>.txt (formato Netscape, o que yt-dlp e gallery-dl leem).
// Tudo é juntado em /data/cookies.combined.txt, que os motores usam.
// Os VALORES dos cookies nunca saem do servidor pela API — só domínio, quantidade e validade.

const DIR = path.join(DATA_DIR, 'cookies');
const COMBINED = path.join(DATA_DIR, 'cookies.combined.txt');
const LEGACY = path.join(DATA_DIR, 'cookies.txt'); // compatível com quem já colocou o arquivo à mão
fs.mkdirSync(DIR, { recursive: true });

const SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'art', 'blog', 'app']);
/** "www.instagram.com" → "instagram.com" · "x.globo.com.br" → "globo.com.br" */
export function baseDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^\./, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h; // endereço IP fica inteiro
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Aceita cookies.txt (Netscape) ou JSON exportado por Cookie-Editor / EditThisCookie. */
export function parseCookies(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error('O JSON de cookies está quebrado. Exporte de novo.'); }
    const arr = Array.isArray(j) ? j : j.cookies || [];
    return arr.filter((c) => c && c.name && c.domain).map((c) => ({
      domain: c.hostOnly ? String(c.domain).replace(/^\./, '') : '.' + String(c.domain).replace(/^\./, ''),
      path: c.path || '/',
      secure: !!c.secure,
      expires: Math.round(Number(c.expirationDate ?? c.expires ?? 0)) || 0,
      name: String(c.name),
      value: String(c.value ?? ''),
      httpOnly: !!c.httpOnly,
    }));
  }
  const out = [];
  for (let line of t.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    out.push({ domain: f[0], path: f[2] || '/', secure: f[3].toUpperCase() === 'TRUE', expires: Number(f[4]) || 0, name: f[5], value: f.slice(6).join('\t'), httpOnly });
  }
  if (!out.length) throw new Error('Não reconheci esse formato. Use o cookies.txt (Netscape) ou o JSON do Cookie-Editor.');
  return out;
}

const toLine = (c) => [
  (c.httpOnly ? '#HttpOnly_' : '') + c.domain,
  c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
  c.path || '/', c.secure ? 'TRUE' : 'FALSE', String(c.expires || 0), c.name, c.value,
].join('\t');

const fileOf = (domain) => path.join(DIR, domain.replace(/[^a-z0-9.-]/gi, '') + '.txt');

/** Salva os cookies colados, separados por site. Devolve os sites atualizados. */
export function saveCookies(text) {
  const all = parseCookies(text);
  const now = Date.now() / 1000;
  const byDomain = new Map();
  for (const c of all) {
    if (c.expires && c.expires < now) continue; // já vencido
    const d = baseDomain(c.domain);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c);
  }
  if (!byDomain.size) throw new Error('Todos esses cookies já estão vencidos. Entre no site de novo e exporte outra vez.');
  for (const [d, list] of byDomain) {
    fs.writeFileSync(fileOf(d), '# Netscape HTTP Cookie File\n' + list.map(toLine).join('\n') + '\n');
  }
  rebuild();
  return [...byDomain.keys()];
}

export function deleteCookies(domain) {
  fs.rmSync(fileOf(domain), { force: true });
  rebuild();
}

function readAll() {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.txt'))) {
    try { out.push(...parseCookies(fs.readFileSync(path.join(DIR, f), 'utf8'))); } catch { /* arquivo ruim: ignora */ }
  }
  try { if (fs.existsSync(LEGACY)) out.push(...parseCookies(fs.readFileSync(LEGACY, 'utf8'))); } catch { /* ignora */ }
  return out;
}

let cache = null;
function rebuild() {
  cache = readAll();
  if (!cache.length) { fs.rmSync(COMBINED, { force: true }); return; }
  fs.writeFileSync(COMBINED, '# Netscape HTTP Cookie File\n' + cache.map(toLine).join('\n') + '\n');
}
rebuild();

/** Arquivo para yt-dlp/gallery-dl (ou null se não tem nenhuma conta). */
export const cookiesFile = () => (fs.existsSync(COMBINED) ? COMBINED : null);

export function listAccounts() {
  const now = Date.now() / 1000;
  return fs.readdirSync(DIR).filter((x) => x.endsWith('.txt')).map((f) => {
    const file = path.join(DIR, f);
    let list = [];
    try { list = parseCookies(fs.readFileSync(file, 'utf8')); } catch { /* vazio */ }
    const exp = list.map((c) => c.expires).filter((e) => e > 0);
    const valid = list.filter((c) => !c.expires || c.expires > now).length;
    return {
      domain: f.replace(/\.txt$/, ''), count: list.length, valid,
      updatedAt: fs.statSync(file).mtime.toISOString(),
      // o login costuma durar até o cookie de sessão mais longo vencer
      expiresAt: exp.length ? new Date(Math.max(...exp) * 1000).toISOString() : null,
    };
  }).sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Cookies que valem para essa URL (para usar em fetch e no navegador invisível). */
export function cookiesFor(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const host = u.hostname.toLowerCase();
  const now = Date.now() / 1000;
  return (cache || []).filter((c) => {
    if (c.expires && c.expires < now) return false;
    const d = c.domain.replace(/^\./, '').toLowerCase();
    return host === d || (c.domain.startsWith('.') && host.endsWith('.' + d)) || host.endsWith('.' + d);
  });
}

export const cookieHeader = (url) => cookiesFor(url).map((c) => `${c.name}=${c.value}`).join('; ');
