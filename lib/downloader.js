import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchAlbumPage, parseAlbum, mediaHeaders, MOBILE_UA, REFERER } from './erome.js';
import { readAlbum, writeAlbum, albumDir, listAlbums } from './store.js';

const FILE_CONCURRENCY = Number(process.env.FILE_CONCURRENCY || 3);
const queue = [];
let running = false;

export function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  runQueue();
}

// Ao reiniciar o servidor, retoma o que ficou pela metade.
export function resumePending() {
  for (const a of listAlbums()) if (['queued', 'downloading'].includes(a.status)) enqueue(a.id);
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try { await processAlbum(id); } catch (e) { console.error('[album]', id, e); }
  }
  running = false;
}

const extFrom = (url, type) => {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  if (m && type !== 'hls') return m[1].toLowerCase();
  return type === 'image' ? 'jpg' : 'mp4';
};

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}

async function downloadHttp(url, dest) {
  const res = await fetch(url, { headers: mediaHeaders() });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} saiu com ${code}: ${err.slice(-300)}`))));
  });
}

async function downloadHls(url, dest) {
  const tmp = dest + '.part.mp4';
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-user_agent', MOBILE_UA,
    '-headers', `Referer: ${REFERER}\r\n`, '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', tmp]);
  fs.renameSync(tmp, dest);
}

async function makeThumb(videoPath, thumbPath) {
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=480:-2', thumbPath]);
    return true;
  } catch { return false; }
}

async function processAlbum(id) {
  let album = readAlbum(id);
  if (!album) return;
  const save = () => writeAlbum(album);
  album.status = 'downloading';
  album.error = null;
  save();

  try {
    if (!album.items.length) {
      const html = await withRetry(() => fetchAlbumPage(album.url));
      const parsed = parseAlbum(html, album.url);
      if (!parsed.items.length) throw new Error('Nenhum vídeo ou imagem encontrado nessa página (álbum privado, removido ou layout mudou).');
      album.title = parsed.title || album.title;
      album.author = parsed.author || album.author;
      const pad = String(parsed.items.length).length < 3 ? 3 : String(parsed.items.length).length;
      album.items = parsed.items.map((it, i) => ({
        ...it,
        file: `${String(i + 1).padStart(pad, '0')}.${extFrom(it.url, it.type)}`,
        status: 'pending',
      }));
      save();
    }

    const dir = albumDir(id);
    const pending = album.items.filter((i) => i.status !== 'done');
    let idx = 0;
    const worker = async () => {
      while (idx < pending.length) {
        const it = pending[idx++];
        it.status = 'downloading'; save();
        const dest = path.join(dir, it.file);
        try {
          await withRetry(() => (it.type === 'hls' ? downloadHls(it.url, dest) : downloadHttp(it.url, dest)));
          it.size = fs.statSync(dest).size;
          it.status = 'done';
          if (it.type !== 'image') {
            const thumb = it.file.replace(/\.[^.]+$/, '.thumb.jpg');
            if (await makeThumb(dest, path.join(dir, thumb))) it.thumb = thumb;
          }
          it.error = null;
        } catch (e) {
          it.status = 'error';
          it.error = String(e.message || e);
        }
        save();
      }
    };
    await Promise.all(Array.from({ length: FILE_CONCURRENCY }, worker));

    album.thumb = album.items.find((i) => i.status === 'done' && i.type === 'image')?.file
      || album.items.find((i) => i.thumb)?.thumb || null;
    const failed = album.items.filter((i) => i.status === 'error').length;
    album.status = failed === 0 ? 'done' : failed === album.items.length ? 'error' : 'partial';
    if (failed) album.error = `${failed} arquivo(s) falharam — toque em "Tentar de novo".`;
    album.finishedAt = new Date().toISOString();
    save();
  } catch (e) {
    album.status = 'error';
    album.error = String(e.message || e);
    save();
  }
}
