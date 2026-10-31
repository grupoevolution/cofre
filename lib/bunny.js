import fs from 'node:fs';
import path from 'node:path';
import { albumDir, findItem, writeAlbum } from './store.js';

// Envio MANUAL para o Bunny Storage (só acontece quando alguém clica "Enviar pro Bunny").
const cfg = () => ({
  zone: process.env.BUNNY_STORAGE_ZONE || '',
  key: process.env.BUNNY_STORAGE_KEY || '',
  host: (process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  cdn: (process.env.BUNNY_CDN_URL || '').replace(/\/$/, ''),
  base: (process.env.BUNNY_BASE_DIR ?? 'cofre').replace(/^\/|\/$/g, ''),
});
export const bunnyEnabled = () => { const c = cfg(); return !!(c.zone && c.key && c.cdn); };

const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60);
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const queue = [];
let running = 0;
const CONCURRENCY = Number(process.env.BUNNY_CONCURRENCY || 2);

/** Coloca itens na fila de envio. `folder` = nome da pasta de destino no Bunny. */
export function queueUpload(keys, folder) {
  if (!bunnyEnabled()) throw new Error('Bunny não configurado no servidor (BUNNY_STORAGE_ZONE, BUNNY_STORAGE_KEY, BUNNY_CDN_URL).');
  const dirName = slug(folder) || 'geral';
  let n = 0;
  for (const key of keys) {
    const f = findItem(key);
    if (!f || f.item.status !== 'done' || f.item.local === false) continue;
    if (f.item.bunny?.status === 'done' && f.item.bunny.dir === dirName) continue;
    if (['queued', 'uploading'].includes(f.item.bunny?.status)) continue;
    f.item.bunny = { status: 'queued', dir: dirName };
    writeAlbum(f.album);
    queue.push(key);
    n++;
  }
  pump();
  return n;
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const key = queue.shift();
    running++;
    upload(key).finally(() => { running--; pump(); });
  }
}

async function upload(key) {
  const f = findItem(key);
  if (!f) return;
  const { album, item } = f;
  const c = cfg();
  const remote = [c.base, item.bunny.dir, `${album.id}-${item.file}`].filter(Boolean).join('/');
  item.bunny.status = 'uploading';
  writeAlbum(album);
  try {
    const file = path.join(albumDir(album.id), item.file);
    const size = fs.statSync(file).size;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(10 * 60e3, size / 200e3 * 1000)); // ≥ 200 KB/s
    try {
      const res = await fetch(`https://${c.host}/${encodeURIComponent(c.zone)}/${encodePath(remote)}`, {
        method: 'PUT',
        headers: { AccessKey: c.key, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: fs.createReadStream(file),
        duplex: 'half',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Bunny respondeu ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    } finally { clearTimeout(timer); }
    Object.assign(item.bunny, { status: 'done', path: remote, url: `${c.cdn}/${encodePath(remote)}`, at: new Date().toISOString(), error: null });
  } catch (e) {
    Object.assign(item.bunny, { status: 'error', error: String(e.name === 'AbortError' ? 'envio demorou demais' : e.message || e) });
  }
  writeAlbum(album);
}

export const bunnyBusy = () => running > 0 || queue.length > 0;

// Se o servidor reiniciar no meio de um envio, volta para a fila.
export function resumeUploads(allItems) {
  if (!bunnyEnabled()) return;
  for (const { album, item } of allItems()) {
    if (['queued', 'uploading'].includes(item.bunny?.status)) {
      item.bunny.status = 'queued';
      writeAlbum(album);
      queue.push(`${album.id}/${item.file}`);
    }
  }
  pump();
}
