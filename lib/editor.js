import { LIMITS } from './config.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
const rect = (r) => {
  if (!r) return null;
  const x = clamp(r.x, 0, 1), y = clamp(r.y, 0, 1);
  const w = clamp(r.w, 0, 1 - x), h = clamp(r.h, 0, 1 - y);
  return w >= 0.01 && h >= 0.01 ? { x, y, w, h } : null;
};
const f = (n) => Number(n).toFixed(5);

/**
 * Valida o que veio do editor. Coordenadas são frações (0–1) da mídia ORIGINAL.
 * { crop:{x,y,w,h}, trim:{start,end}, blur:{all, areas:[{x,y,w,h}], strength:1|2|3}, toVideo:{duration} }
 */
export function cleanSpec(raw, type) {
  const s = {};
  const c = rect(raw?.crop);
  if (c && !(c.x === 0 && c.y === 0 && c.w > 0.995 && c.h > 0.995)) s.crop = c;
  if (type === 'video' && raw?.trim) {
    const start = Math.max(0, Number(raw.trim.start) || 0);
    const end = Number(raw.trim.end) || 0;
    if (end && end - start < 0.3) throw new Error('O trecho escolhido é curto demais.');
    if (start > 0.05 || end) s.trim = { start, end: end || null };
  }
  const areas = (raw?.blur?.areas || []).map(rect).filter(Boolean).slice(0, 10);
  if (raw?.blur?.all || areas.length) {
    s.blur = { all: Boolean(raw.blur.all), areas: raw.blur.all ? [] : areas, strength: clamp(raw.blur.strength || 2, 1, 3) };
  }
  if (type === 'image' && raw?.toVideo) s.toVideo = { duration: clamp(raw.toVideo.duration || 5, 1, 60) };
  if (!Object.keys(s).length) throw new Error('Nenhuma edição foi feita.');
  return s;
}

/** Monta o comando do ffmpeg. Devolve { args, outType, ext }. */
export function buildEdit(spec, { type, ext, width, height, hasAudio }, src, dest) {
  const outVideo = type === 'video' || Boolean(spec.toVideo);
  const sigma = Math.max(4, Math.round(Math.min(width || 1000, height || 1000) * [0, 0.015, 0.035, 0.07][spec.blur?.strength || 2]));
  const chain = [];
  let last = '[0:v]', n = 0;
  const step = (filter) => { const out = `[s${n++}]`; chain.push(`${last}${filter}${out}`); last = out; };

  if (spec.blur?.all) step(`gblur=sigma=${sigma}`);
  const areas = spec.blur?.areas || [];
  if (areas.length) {
    const labels = areas.map((_, i) => `[a${i}]`);
    chain.push(`${last}split=${areas.length + 1}[base]${labels.join('')}`);
    let base = '[base]';
    areas.forEach((a, i) => {
      chain.push(`[a${i}]crop=w=iw*${f(a.w)}:h=ih*${f(a.h)}:x=iw*${f(a.x)}:y=ih*${f(a.y)},gblur=sigma=${sigma}[b${i}]`);
      const out = `[o${i}]`;
      chain.push(`${base}[b${i}]overlay=x=main_w*${f(a.x)}:y=main_h*${f(a.y)}${out}`);
      base = out;
    });
    last = base;
  }
  if (spec.crop) {
    const c = spec.crop;
    step(`crop=w=iw*${f(c.w)}:h=ih*${f(c.h)}:x=iw*${f(c.x)}:y=ih*${f(c.y)}`);
  }
  if (outVideo) step('scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p');
  else step('null');
  chain[chain.length - 1] = chain[chain.length - 1].replace(/\[s\d+\]$/, '[out]');

  const input = [];
  if (spec.trim && type === 'video') {
    input.push('-ss', String(spec.trim.start));
    if (spec.trim.end) input.push('-t', String(Math.max(0.3, spec.trim.end - spec.trim.start)));
  }
  if (spec.toVideo) input.push('-loop', '1', '-framerate', '30', '-t', String(spec.toVideo.duration));

  const outExt = outVideo ? 'mp4' : (['png', 'webp'].includes(ext) ? ext : 'jpg');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-threads', String(LIMITS.ffmpegThreads),
    ...input, '-i', src, '-filter_complex', chain.join(';'), '-map', '[out]'];
  if (outVideo) {
    if (type === 'video' && hasAudio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k');
    args.push('-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast', '-crf', '20',
      ...(spec.toVideo ? ['-r', '30'] : []), '-movflags', '+faststart', '-filter_complex_threads', '1');
  } else {
    args.push('-frames:v', '1');
    if (outExt === 'jpg') args.push('-q:v', '2');
  }
  args.push(dest);
  return { args, outType: outVideo ? 'video' : 'image', ext: outExt };
}
