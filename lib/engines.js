import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run, typeOf } from './media.js';
import { cookiesFile, cookieHeader } from './cookies.js';
import { netFetch, PROXY_URL, isBlockStatus } from './net.js';

// Motores externos. Os caminhos podem ser trocados por variável (útil para teste local).
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const GALLERYDL = process.env.GALLERYDL_BIN || 'gallery-dl';
const MAX_PER_LINK = Number(process.env.MAX_PER_LINK || 300);
const IDLE_MS = Number(process.env.DOWNLOAD_IDLE_SEC || 300) * 1000;
const TOTAL_MS = Number(process.env.DOWNLOAD_MAX_MIN || 240) * 60e3;
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Baixa um arquivo por HTTP com limite de tempo:
 * cancela se o servidor ficar `idleMs` sem mandar nenhum byte (conexão travada).
 * Manda os cookies da conta daquele site, se houver. `proxy: true` passa pelo proxy.
 */
export async function downloadHttp(url, dest, headers = {}, { idleMs = 60e3, proxy = false } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(new Error('conexão travada (sem resposta)')), 45e3);
  const tmp = dest + '.part';
  const cookie = headers.Cookie || headers.cookie || cookieHeader(url);
  try {
    const res = await netFetch(url, {
      headers: { 'User-Agent': DESKTOP_UA, ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      signal: ctrl.signal, redirect: 'follow',
    }, { proxy });
    if (!res.ok || !res.body) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const watchdog = new Transform({
      transform(chunk, _enc, cb) {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new Error('download parou de receber dados')), idleMs);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), watchdog, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return res.headers.get('content-type') || '';
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : e;
  } finally {
    clearTimeout(timer);
  }
}
export const httpBlocked = (e) => isBlockStatus(e?.status);

/** Vídeo em streaming (.m3u8) → .mp4, com os cabeçalhos que o site exige. */
export async function downloadHls(url, dest, { referer, ua = DESKTOP_UA, proxy = false } = {}) {
  const tmp = dest + '.part.mp4';
  const cookie = cookieHeader(url);
  const headers = [referer && `Referer: ${referer}`, cookie && `Cookie: ${cookie}`].filter(Boolean).map((h) => h + '\r\n').join('');
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats_period', '5', '-progress', 'pipe:2',
      '-rw_timeout', '30000000', '-user_agent', ua, ...(headers ? ['-headers', headers] : []),
      ...(proxy && PROXY_URL ? ['-http_proxy', PROXY_URL] : []),
      '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', tmp], { idleMs: 120e3, totalMs: 3 * 3600e3 });
    fs.renameSync(tmp, dest);
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Link que já é o próprio arquivo (termina em .mp4, .jpg…). */
export const isDirectMedia = (url) => {
  try { return !!typeOf(new URL(url).pathname); } catch { return false; }
};

/**
 * yt-dlp: vídeos de ~1.800 sites (inclui playlists e perfis inteiros).
 * Chama onFile(caminho, {title, uploader, playlist}) a cada arquivo pronto e onProgress('45%').
 */
export async function ytdlp(url, dir, { onFile, onProgress, proxy = false }) {
  const args = [
    '--newline', '--progress', '--no-warnings', '--restrict-filenames', '--no-mtime', '--ignore-errors',
    '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '5',
    '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
    '--playlist-items', `1:${MAX_PER_LINK}`,
    '--download-archive', path.join(dir, '.ytdlp-archive'),
    '-o', path.join(dir, '%(id).80B.%(ext)s'),
    '--print', 'after_move:COFRE\t%(filepath)s\t%(title).200B\t%(uploader|)s\t%(playlist_title|)s',
    '--no-simulate',
  ];
  const c = cookiesFile();
  if (c) args.push('--cookies', c);
  if (proxy && PROXY_URL) args.push('--proxy', PROXY_URL);
  args.push(url);
  return runEngine(YTDLP, args, (line) => {
    if (line.startsWith('COFRE\t')) {
      const [, file, title, uploader, playlist] = line.split('\t');
      onFile(file, { title, uploader, playlist });
    } else {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) onProgress?.(`${Math.round(Number(m[1]))}%`);
    }
  });
}

/** gallery-dl: fotos e álbuns de centenas de sites (Reddit, Imgur, Instagram, coomer…). */
export async function gallerydl(url, dir, { onFile, proxy = false }) {
  const args = [
    '-D', dir,
    '-f', '{filename}.{extension}',
    '--download-archive', path.join(dir, '.gallerydl-archive.sqlite3'),
    '--range', `1-${MAX_PER_LINK}`,
    '--http-timeout', '30', '--retries', '5',
  ];
  const c = cookiesFile();
  if (c) args.push('--cookies', c);
  if (proxy && PROXY_URL) args.push('--proxy', PROXY_URL);
  args.push(url);
  return runEngine(GALLERYDL, args, (line) => {
    const p = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^#\s+/, '').trim();
    if (path.isAbsolute(p) && p.startsWith(dir) && fs.existsSync(p)) onFile(p, {});
  });
}

// BIN pode ser 'programa|arg1' (usado no teste local para simular o motor)
const splitBin = (b) => { const [cmd, ...pre] = b.split('|'); return [cmd, pre]; };

/** Devolve { ok } ou { ok:false, error: texto do erro (para o diagnóstico), missing } */
async function runEngine(bin, args, onLine) {
  const [cmd, pre] = splitBin(bin);
  try {
    await run(cmd, [...pre, ...args], { idleMs: IDLE_MS, totalMs: TOTAL_MS, onLine });
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true, error: `${cmd} não está instalado no servidor` };
    const out = String(e.output || e.message);
    const errLines = out.split('\n').filter((l) => /error|travou|tempo máximo/i.test(l));
    return { ok: false, error: (errLines.slice(-3).join(' | ') || out.trim().split('\n').pop() || 'falhou').replace(/\s+/g, ' ').slice(0, 400) };
  }
}

/** O motor falhou por bloqueio do site? (vale tentar de novo pelo proxy) */
export const engineBlocked = (r) => !r.ok && !/login required/i.test(r.error || '') && /not a bot|HTTP Error 4(03|29)|\b429\b|Too Many Requests|rate.?limit|captcha|cloudflare|blocked|geo.?restrict|not available in your/i.test(r.error || '');

// Versões instaladas (mostradas no app) + atualização automática diária dos motores.
export const engineVersions = { 'yt-dlp': null, 'gallery-dl': null };
async function readVersions() {
  for (const [name, bin] of [['yt-dlp', YTDLP], ['gallery-dl', GALLERYDL]]) {
    const [cmd, pre] = splitBin(bin);
    try { engineVersions[name] = (await run(cmd, [...pre, '--version'], { idleMs: 30e3, totalMs: 30e3 })).trim().split('\n').pop(); }
    catch { engineVersions[name] = null; }
  }
}
export function startEngineUpdater() {
  readVersions();
  if (process.env.AUTO_UPDATE_ENGINES === '0') return;
  const update = () => run('pip', ['install', '-q', '-U', '--break-system-packages', 'yt-dlp', 'gallery-dl'],
    { idleMs: 5 * 60e3, totalMs: 10 * 60e3 }).then(readVersions).catch(() => {});
  setTimeout(update, 60e3);
  setInterval(update, 24 * 3600e3).unref();
}
