import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'ts', '3gp', 'wmv']);
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'heic']);
export const extOf = (f) => (String(f).match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toLowerCase();
export const typeOf = (f) => (VIDEO_EXT.has(extOf(f)) ? 'video' : IMAGE_EXT.has(extOf(f)) ? 'image' : null);

/**
 * Roda um programa com dois limites de tempo:
 *  - idleMs: mata o processo se ficar esse tempo sem escrever nada (travou)
 *  - totalMs: tempo máximo absoluto
 * onLine recebe cada linha de stdout/stderr (para ler progresso e arquivos prontos).
 */
export function run(cmd, args, { idleMs = 5 * 60e3, totalMs = 3 * 3600e3, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let killedBy = null;
    let idle;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { killedBy = `travou (${Math.round(idleMs / 1000)}s sem resposta)`; p.kill('SIGKILL'); }, idleMs);
    };
    const total = setTimeout(() => { killedBy = `passou do tempo máximo (${Math.round(totalMs / 60e3)} min)`; p.kill('SIGKILL'); }, totalMs);
    kick();
    const feed = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        kick();
        const s = d.toString();
        tail = (tail + s).slice(-4000);
        if (!onLine) return;
        buf += s;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l);
      });
      stream.on('end', () => { if (onLine && buf.trim()) onLine(buf); });
    };
    feed(p.stdout);
    feed(p.stderr);
    p.on('error', (e) => { clearTimeout(idle); clearTimeout(total); reject(e); });
    p.on('close', (code) => {
      clearTimeout(idle); clearTimeout(total);
      if (code === 0 && !killedBy) return resolve(tail);
      const err = new Error(killedBy ? `${cmd} ${killedBy}` : `${cmd} saiu com ${code}: ${tail.slice(-400).trim()}`);
      err.output = tail;
      reject(err);
    });
  });
}

export async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** Largura, altura, duração e rotação (vídeo de celular gravado em pé vem "deitado" + rotação). */
export async function probe(file) {
  let out = '';
  try {
    out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration',
      '-of', 'json', file], { idleMs: 60e3, totalMs: 120e3 });
  } catch { return {}; }
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')));
    const s = j.streams?.[0] || {};
    const rot = Math.abs(Number(s.side_data_list?.find((x) => x.rotation != null)?.rotation ?? s.tags?.rotate ?? 0));
    let { width, height } = s;
    if (rot === 90 || rot === 270) [width, height] = [height, width];
    const duration = Number(j.format?.duration);
    return { width: width || null, height: height || null, duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null, rotated: rot !== 0 };
  } catch { return {}; }
}

export async function makeThumb(videoPath, thumbPath, duration) {
  const at = duration && duration < 3 ? 0 : 1;
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(at), '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=480:-2', thumbPath], { idleMs: 60e3, totalMs: 120e3 });
    return fs.existsSync(thumbPath);
  } catch { return false; }
}

/**
 * Remove dados escondidos (câmera, GPS, data, programa usado, título embutido).
 * Vídeo: cópia sem recompressão. Foto: regravada em qualidade máxima.
 * Se der qualquer erro, mantém o arquivo original.
 */
export async function stripMetadata(file, type, { rotated } = {}) {
  if (process.env.STRIP_METADATA === '0') return false;
  const ext = extOf(file);
  if (type === 'video' && rotated) return false; // não arrisca virar o vídeo de lado
  if (type === 'image' && !['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return false;
  const tmp = file + '.clean.' + ext;
  const args = type === 'video'
    ? ['-y', '-loglevel', 'error', '-i', file, '-map', '0', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', tmp]
    : ['-y', '-loglevel', 'error', '-i', file, '-map_metadata', '-1', ...(ext === 'png' ? [] : ['-q:v', '2']), tmp];
  try {
    await run('ffmpeg', args, { idleMs: 120e3, totalMs: 30 * 60e3 });
    if (fs.statSync(tmp).size > 0) { fs.renameSync(tmp, file); return true; }
  } catch { /* mantém o original */ }
  fs.rmSync(tmp, { force: true });
  return false;
}

/** Roda o ffmpeg e devolve a saída binária (para ler pixels). */
function ffmpegRaw(args, timeoutMs = 60e3) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg ' + code)); });
  });
}

/**
 * "Impressão visual" (dHash 64 bits): fotos/vídeos parecidos dão números parecidos,
 * mesmo com recorte leve, outra qualidade ou outro tamanho.
 */
export async function visualHash(file, type, duration) {
  const seek = type === 'video' ? ['-ss', String(Math.max(0, (duration || 2) * 0.4))] : [];
  const px = await ffmpegRaw(['-loglevel', 'error', ...seek, '-i', file, '-frames:v', '1',
    '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-']);
  if (px.length < 72) throw new Error('quadro vazio');
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}
export function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Quadros em vários pontos do vídeo (para prévia e para as legendas automáticas). */
export async function grabFrames(video, duration, count, outDir, width = 160) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i++) {
    const at = ((i + 0.5) / count) * (duration || 1);
    const f = `${outDir}/f${String(i).padStart(2, '0')}.jpg`;
    try {
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1',
        '-vf', `scale=${width}:-2`, '-q:v', '4', f], { idleMs: 60e3, totalMs: 90e3 });
      if (fs.existsSync(f)) files.push(f);
    } catch { /* um quadro ruim não impede os outros */ }
  }
  return files;
}

export const SPRITE = { cols: 6, rows: 4 };
/** Prévia de vídeo longo: 24 quadros numa imagem só (passar o dedo na miniatura mostra o vídeo todo). */
export async function makeSprite(video, spritePath, duration) {
  const tmp = spritePath + '.frames';
  try {
    const n = SPRITE.cols * SPRITE.rows;
    const frames = await grabFrames(video, duration, n, tmp, 160);
    if (frames.length < n) return false;
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${tmp}/f%02d.jpg`,
      '-vf', `tile=${SPRITE.cols}x${SPRITE.rows}`, '-frames:v', '1', '-q:v', '5', spritePath], { idleMs: 60e3, totalMs: 120e3 });
    return fs.existsSync(spritePath);
  } catch { return false; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Corta um trecho (recodifica para o corte ficar exato no segundo escolhido). */
export async function cutClip(src, dest, start, end) {
  const tmp = dest + '.part.mp4';
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-i', src, '-t', String(end - start),
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { idleMs: 120e3, totalMs: 20 * 60e3 });
    fs.renameSync(tmp, dest);
  } finally { fs.rmSync(tmp, { force: true }); }
}
