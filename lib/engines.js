import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from './store.js';
import { run, typeOf } from './media.js';

// Motores externos. Os caminhos podem ser trocados por variável (útil para teste local).
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const GALLERYDL = process.env.GALLERYDL_BIN || 'gallery-dl';
const MAX_PER_LINK = Number(process.env.MAX_PER_LINK || 300);
const IDLE_MS = Number(process.env.DOWNLOAD_IDLE_SEC || 300) * 1000;
const TOTAL_MS = Number(process.env.DOWNLOAD_MAX_MIN || 240) * 60e3;
const cookiesFile = () => {
  const f = path.join(DATA_DIR, 'cookies.txt');
  return fs.existsSync(f) ? f : null;
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Baixa um arquivo por HTTP com limite de tempo:
 * cancela se o servidor ficar `idleMs` sem mandar nenhum byte (conexão travada).
 */
export async function downloadHttp(url, dest, headers = {}, { idleMs = 60e3 } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(new Error('conexão travada (sem resposta)')), 45e3);
  const tmp = dest + '.part';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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

/** Link que já é o próprio arquivo (termina em .mp4, .jpg…). */
export const isDirectMedia = (url) => {
  try { return !!typeOf(new URL(url).pathname); } catch { return false; }
};

/**
 * yt-dlp: vídeos de ~1.800 sites (inclui playlists e perfis inteiros).
 * Chama onFile(caminho, {title, uploader, playlist}) a cada arquivo pronto e onProgress('45%').
 */
export async function ytdlp(url, dir, { onFile, onProgress }) {
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
export async function gallerydl(url, dir, { onFile }) {
  const args = [
    '-D', dir,
    '-f', '{filename}.{extension}',
    '--download-archive', path.join(dir, '.gallerydl-archive.sqlite3'),
    '--range', `1-${MAX_PER_LINK}`,
    '--http-timeout', '30', '--retries', '5',
  ];
  const c = cookiesFile();
  if (c) args.push('--cookies', c);
  args.push(url);
  return runEngine(GALLERYDL, args, (line) => {
    const p = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^#\s+/, '').trim();
    if (path.isAbsolute(p) && p.startsWith(dir) && fs.existsSync(p)) onFile(p, {});
  });
}

// BIN pode ser 'programa|arg1' (usado no teste local para simular o motor)
const splitBin = (b) => { const [cmd, ...pre] = b.split('|'); return [cmd, pre]; };

async function runEngine(bin, args, onLine) {
  const [cmd, pre] = splitBin(bin);
  try {
    await run(cmd, [...pre, ...args], { idleMs: IDLE_MS, totalMs: TOTAL_MS, onLine });
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true, error: `${bin} não está instalado no servidor` };
    return { ok: false, error: summarizeError(e.output || e.message) };
  }
}

// Transforma o erro técnico numa frase que dá pra entender.
function summarizeError(out) {
  const s = String(out);
  if (/Unsupported URL|No suitable extractor|Unsupported URL:/i.test(s)) return 'site não suportado';
  if (/login|sign in|cookies|authenticat|private/i.test(s)) return 'o site pediu login (coloque um cookies.txt no servidor)';
  if (/HTTP Error 403|403 Forbidden/i.test(s)) return 'o site bloqueou o acesso (403)';
  if (/HTTP Error 404|404/i.test(s)) return 'não encontrado (404) — removido ou link errado';
  if (/travou|tempo máximo/i.test(s)) return s.split('\n').find((l) => /travou|tempo máximo/.test(l)) || s;
  const last = s.trim().split('\n').reverse().find((l) => /error/i.test(l)) || s.trim().split('\n').pop() || 'falhou';
  return last.replace(/^.*?ERROR:\s*/i, '').slice(0, 240);
}

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
