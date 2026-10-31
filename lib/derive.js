// Arquivos DERIVADOS de outro arquivo da biblioteca:
//  - "Fotos do vídeo": os melhores quadros (nítidos, bem iluminados e diferentes entre si) viram fotos.
//  - "Kit pro app": a mesma mídia nos formatos que o app usa (9:16 Status, 4:5 feed/grupo, borrada p/ venda).
// Roda um por vez, em segundo plano, e respeita o freio do vigia da VPS.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { albumDir, findItem, writeAlbum, itemKey, VISIBLE } from './store.js';
import { run, hamming } from './media.js';
import { logEvent } from './activity.js';
import { finalize } from './downloader.js';
import { maxAlbums, onRelease } from './health.js';

export const KIT_FORMATS = {
  '916': { label: '9:16 (Status)', ratio: '9/16', w: 1080, h: 1920 },
  '45': { label: '4:5 (feed e grupo)', ratio: '4/5', w: 1080, h: 1350 },
  blur: { label: 'borrada (venda)' },
};

export const deriveState = { queue: 0, current: null, done: 0 };
const queue = [];
let running = false;

const mmss = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
const baseOf = (file) => file.replace(/\.[^.]+$/, '');

/** Fila: { kind: 'frames', key, count } | { kind: 'kit', key, formats, start, end } */
export function queueDerive(job) {
  queue.push(job);
  deriveState.queue = queue.length;
  pump();
}
onRelease(() => pump());

async function pump() {
  if (running) return;
  running = true;
  while (queue.length && maxAlbums(1) > 0) { // vigia pausou downloads? isto também espera
    const job = queue.shift();
    deriveState.queue = queue.length;
    const f = findItem(job.key);
    deriveState.current = f ? `${job.kind === 'frames' ? '📸 Fotos de' : '🧰 Kit de'} ${f.item.title || f.item.file}` : null;
    try {
      if (f) await (job.kind === 'frames' ? extractFrames(f, job) : makeKit(f, job));
      deriveState.done++;
    } catch (e) {
      if (f) { logEvent(f.album, `✖ ${job.kind === 'frames' ? 'Fotos' : 'Kit'} de ${f.item.file}: ${String(e.message || e).slice(0, 160)}`); writeAlbum(f.album); }
    }
  }
  deriveState.current = null;
  deriveState.queue = queue.length;
  running = false;
}

/** Cria o item novo, gera o arquivo e passa pelo mesmo acabamento dos downloads (miniatura, impressão, legendas, Bunny). */
async function addDerived(album, src, extra, produce) {
  if (album.items.some((i) => i.file === extra.file && VISIBLE(i))) return null; // já existe
  const it = {
    status: 'processing', derivedFrom: itemKey(album, src), folders: [...(src.folders || [])], ...extra,
  };
  album.items = album.items.filter((i) => i.file !== it.file);
  album.items.push(it);
  writeAlbum(album);
  try {
    await produce(path.join(albumDir(album.id), it.file));
    await finalize(album, it);
    // parecido com o próprio original ou com um irmão derivado dele não é "repetido"
    const sim = it.similarTo && findItem(it.similarTo);
    if (sim && (it.similarTo === it.derivedFrom || sim.item.derivedFrom === it.derivedFrom)) it.similarTo = null;
  } catch (e) {
    it.status = 'error';
    it.error = String(e.message || e).slice(0, 200);
    fs.rmSync(path.join(albumDir(album.id), it.file), { force: true });
  }
  writeAlbum(album);
  return it;
}

const ffmpeg = (args, totalMs = 20 * 60e3) => run('ffmpeg', ['-y', '-loglevel', 'error', ...args], { idleMs: 120e3, totalMs });

// ---------- Fotos tiradas do vídeo ----------
/** Nitidez (variação das bordas), brilho e contraste de um quadro + impressão visual para evitar repetidos. */
async function scoreFrame(file) {
  const img = sharp(file).greyscale();
  const [{ channels: [st] }, { channels: [edge] }, raw] = await Promise.all([
    img.clone().stats(),
    img.clone().convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] }).stats(),
    img.clone().resize(9, 8, { fit: 'fill' }).raw().toBuffer(),
  ]);
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += raw[y * 9 + x] > raw[y * 9 + x + 1] ? '1' : '0';
  return { mean: st.mean, contrast: st.stdev, sharp: edge.stdev, hash: BigInt('0b' + bits).toString(16).padStart(16, '0') };
}

/** Quantas fotos tirar: ~3 num vídeo de 30 s, ~24 num de 40 min, no máximo 30. */
export const framesFor = (dur) => Math.max(3, Math.min(30, Math.round(Math.sqrt(dur || 0) * 0.5)));

async function extractFrames({ album, item }, { count }) {
  if (item.type !== 'video' || item.local === false) throw new Error('precisa ser um vídeo que está no servidor');
  const dur = item.duration || 0;
  if (dur < 3) throw new Error('vídeo curto demais');
  const want = Math.max(1, Math.min(60, Number(count) || framesFor(dur)));
  const dir = albumDir(album.id);
  const src = path.join(dir, item.file);
  const tmp = path.join(dir, `.frames-${baseOf(item.file)}`);
  logEvent(album, `📸 Procurando as melhores fotos em ${item.file}`);
  try {
    // candidatos espalhados pelo vídeo inteiro (pula 3% do começo e do fim: vinheta/tela preta)
    const n = Math.max(12, Math.min(120, want * 5, Math.round(dur / 3)));
    fs.mkdirSync(tmp, { recursive: true });
    const cands = [];
    for (let i = 0; i < n; i++) {
      const at = dur * 0.03 + ((i + 0.5) / n) * dur * 0.94;
      const f = path.join(tmp, `c${i}.jpg`);
      try {
        await ffmpeg(['-ss', at.toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', f], 90e3);
        if (!fs.existsSync(f)) continue;
        const s = await scoreFrame(f);
        if (s.mean < 30 || s.mean > 235 || s.contrast < 18) continue; // escuro, estourado ou tela lisa
        cands.push({ at, ...s });
      } catch { /* quadro ruim */ }
    }
    // mais nítidos primeiro; só entra se for diferente das já escolhidas e longe no tempo
    cands.sort((a, b) => b.sharp - a.sharp);
    const gap = Math.max(2, dur / (want * 3));
    const picked = [];
    for (const c of cands) {
      if (picked.length >= want) break;
      if (picked.some((p) => hamming(p.hash, c.hash) <= 12 || Math.abs(p.at - c.at) < gap)) continue;
      picked.push(c);
    }
    picked.sort((a, b) => a.at - b.at);
    let made = 0;
    for (const p of picked) {
      const it = await addDerived(album, item, {
        file: `${baseOf(item.file)}-foto-${mmss(p.at)}.jpg`, type: 'image', frameOf: itemKey(album, item), frameAt: Math.round(p.at),
        title: `Foto em ${mmss(p.at).replace('m', ':').replace('s', '')} de ${item.title || album.title || item.file}`,
      }, (dest) => ffmpeg(['-ss', p.at.toFixed(2), '-i', src, '-frames:v', '1', '-q:v', '2', dest], 120e3));
      if (it?.status === 'done') made++;
    }
    logEvent(album, `📸 ${made} foto(s) tiradas de ${item.file}${cands.length < want ? ' (o vídeo tinha poucos quadros bons)' : ''}`);
    writeAlbum(album);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- Kit pronto pro app ----------
const cropTo = (ratio) => `crop='min(iw,ih*${ratio})':'min(ih,iw/(${ratio}))'`;
const BLUR = "scale='trunc(iw/16)*2':-2,gblur=sigma=4,scale=1080:-2";

async function makeKit({ album, item }, { formats, start, end }) {
  if (item.local === false) throw new Error('o arquivo só está no Bunny');
  const fmts = [].concat(formats || Object.keys(KIT_FORMATS)).filter((f) => KIT_FORMATS[f]);
  if (!fmts.length) throw new Error('nenhum formato escolhido');
  const src = path.join(albumDir(album.id), item.file);
  const base = baseOf(item.file);
  const isVideo = item.type === 'video';
  let s = 0, e = 0;
  if (isVideo) {
    // trecho: o que você marcou no visualizador, ou 10 s do meio do vídeo (máx. 60 s)
    const dur = item.duration || 0;
    s = Number.isFinite(Number(start)) && start !== null ? Math.max(0, Number(start)) : Math.max(0, dur / 2 - 5);
    e = Number.isFinite(Number(end)) && end !== null ? Math.min(dur || Infinity, Number(end)) : Math.min(dur, s + 10);
    if (!(e > s + 0.5)) throw new Error('trecho inválido');
    if (e - s > 60) e = s + 60;
  }
  logEvent(album, `🧰 Kit de ${item.file}: ${fmts.map((f) => KIT_FORMATS[f].label).join(', ')}${isVideo ? ` (trecho ${mmss(s)}–${mmss(e)})` : ''}`);
  for (const f of fmts) {
    const def = KIT_FORMATS[f];
    const vf = f === 'blur' ? BLUR : `${cropTo(def.ratio)},scale='min(${def.w},iw)':-2,setsar=1`;
    const tag = isVideo ? `${f}-${Math.round(s)}-${Math.round(e)}` : f;
    await addDerived(album, item, {
      file: `${base}-kit-${tag}.${isVideo ? 'mp4' : 'jpg'}`, type: item.type, kitOf: itemKey(album, item), kit: f,
      title: `Kit ${def.label} · ${item.title || album.title || item.file}`,
    }, (dest) => (isVideo
      ? ffmpeg(['-ss', String(s), '-i', src, '-t', String(e - s), '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', dest + '.part.mp4']).then(() => fs.renameSync(dest + '.part.mp4', dest))
      : ffmpeg(['-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '2', dest], 120e3)));
  }
  writeAlbum(album);
}
