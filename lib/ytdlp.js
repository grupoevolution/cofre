import fs from 'node:fs';
import { run } from './ffmpeg.js';
import { LIMITS } from './config.js';

// yt-dlp baixa vídeos do xvideos e do TikTok (sem marca d'água).
const BIN = process.env.YTDLP_BIN || 'yt-dlp';
const base = () => ['--no-playlist', '--no-warnings', '--socket-timeout', String(Math.ceil(LIMITS.idleTimeoutMs / 1000)),
  '--retries', '3', '--no-cache-dir'];

const clean = (e) => {
  const msg = String(e.message || e);
  const line = msg.split(/\n|: ERROR: | ERROR: /).map((s) => s.trim()).filter(Boolean).pop() || msg;
  if (/ENOENT/.test(msg)) return 'yt-dlp não está instalado no servidor';
  if (/private|login|log in|sign in/i.test(msg)) return 'Vídeo privado ou que exige login.';
  if (/not available|removed|404|does not exist/i.test(msg)) return 'Vídeo indisponível ou removido.';
  return line.replace(/^ERROR:\s*/, '').slice(0, 220);
};

export async function version() {
  try { return (await run(BIN, ['--version'], { timeoutMs: 20_000 })).trim(); } catch { return null; }
}

// Atualiza o yt-dlp em segundo plano (os sites mudam e ele é corrigido com frequência)
export function selfUpdate() {
  run(BIN, ['-U'], { timeoutMs: 120_000 }).then((o) => {
    const l = o.trim().split('\n').pop();
    if (l) console.log('[yt-dlp]', l);
  }).catch(() => {});
}

/** Lê título/autor sem baixar. */
export async function info(url) {
  try {
    const out = await run(BIN, [...base(), '-J', url], { timeoutMs: 90_000 });
    const j = JSON.parse(out);
    return { id: j.id, title: j.title || j.description?.slice(0, 80) || '', author: j.uploader || j.channel || j.creator || '',
      duration: j.duration || null, ext: 'mp4' };
  } catch (e) { throw new Error(clean(e)); }
}

/** Baixa o vídeo em MP4 (melhor qualidade disponível), com progresso. */
export async function download(url, dest, { signal, onProgress } = {}) {
  const tmp = dest + '.ytdl.mp4';
  let buf = '';
  try {
    await run(BIN, [...base(), '-f', 'bv*+ba/b', '-S', 'vcodec:h264,acodec:aac,res,ext:mp4:m4a', '--merge-output-format', 'mp4',
      '--no-part', '--force-overwrites', '--newline', '--progress-template', 'download:P %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s',
      '-o', tmp, url], {
      timeoutMs: 60 * 60_000, signal, nice: true,
      onStdout: (d) => {
        buf = (buf + d).slice(-500);
        const m = [...buf.matchAll(/P (\d+) (\d+|NA)/g)].pop();
        if (m) onProgress?.(Number(m[1]), m[2] === 'NA' ? 0 : Number(m[2]));
      },
    });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('o yt-dlp não gerou o arquivo');
    fs.renameSync(tmp, dest);
  } catch (e) {
    throw new Error(clean(e));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
