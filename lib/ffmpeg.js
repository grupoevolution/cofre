import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LIMITS } from './config.js';
import { MOBILE_UA, REFERER } from './erome.js';

// Semáforo simples: no máximo N tarefas pesadas ao mesmo tempo.
export class Semaphore {
  constructor(n) { this.n = n; this.active = 0; this.waiting = []; }
  async acquire() {
    if (this.active < this.n) { this.active++; return; }
    await new Promise((r) => this.waiting.push(r));
    this.active++;
  }
  release() { this.active--; this.waiting.shift()?.(); }
  async use(fn) { await this.acquire(); try { return await fn(); } finally { this.release(); } }
}
export const ffmpegSlot = new Semaphore(LIMITS.ffmpeg);

const useNice = process.env.FFMPEG_NICE !== '0';

/** Roda um comando com tempo máximo; mata o processo se passar do tempo ou se for cancelado. */
export function run(cmd, args, { timeoutMs = 30 * 60_000, signal, nice = false, onStderr, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const [c, a] = nice && useNice ? ['nice', ['-n', '10', cmd, ...args]] : [cmd, args];
    const p = spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 8e6) out = out.slice(-8e6); onStdout?.(String(d)); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); onStderr?.(String(d)); });
    const kill = (why) => { p.kill('SIGKILL'); reject(new Error(why)); };
    const t = setTimeout(() => kill(`${cmd} passou do tempo limite`), timeoutMs);
    const onAbort = () => kill('cancelado');
    signal?.addEventListener('abort', onAbort, { once: true });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} falhou (${code}): ${err.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
    });
  });
}

const threads = () => ['-threads', String(LIMITS.ffmpegThreads)];

export async function probe(file) {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height',
      '-of', 'json', file], { timeoutMs: 60_000 });
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
    const d = Number(j.format?.duration);
    return { width: v.width || null, height: v.height || null, duration: Number.isFinite(d) ? d : null,
      hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio') };
  } catch { return { width: null, height: null, duration: null, hasAudio: false }; }
}

/** Miniatura leve (480px) para a grade — tanto de foto quanto de vídeo. */
export async function makeThumb(src, type, dest) {
  const base = ['-y', '-hide_banner', '-loglevel', 'error', ...threads()];
  const vf = ['-vf', "scale='min(480,iw)':-2", '-frames:v', '1', '-q:v', '5', dest];
  const tries = type === 'image'
    ? [[...base, '-i', src, ...vf]]
    : [[...base, '-ss', '1', '-i', src, ...vf], [...base, '-i', src, ...vf]];
  for (const args of tries) {
    try {
      await ffmpegSlot.use(() => run('ffmpeg', args, { timeoutMs: 120_000, nice: true }));
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    } catch { /* tenta a próxima forma */ }
  }
  return false;
}

/** Baixa vídeo HLS (.m3u8) juntando os pedaços sem recodificar. */
export async function downloadHls(url, dest, signal) {
  const tmp = dest + '.part.mp4';
  try {
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-rw_timeout', String(LIMITS.idleTimeoutMs * 1000),
      '-user_agent', MOBILE_UA, '-headers', `Referer: ${REFERER}\r\n`, '-i', url,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', tmp], { timeoutMs: 60 * 60_000, signal });
    fs.renameSync(tmp, dest);
  } finally { fs.rmSync(tmp, { force: true }); }
}
