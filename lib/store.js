import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const ALBUMS_DIR = path.join(DATA_DIR, 'albums');
fs.mkdirSync(ALBUMS_DIR, { recursive: true });

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '');
export const albumDir = (id) => path.join(ALBUMS_DIR, safeId(id));
const metaPath = (id) => path.join(albumDir(id), 'meta.json');

export function readAlbum(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}

export function writeAlbum(album) {
  fs.mkdirSync(albumDir(album.id), { recursive: true });
  const tmp = metaPath(album.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(album, null, 2));
  fs.renameSync(tmp, metaPath(album.id));
}

export function listAlbums() {
  return fs.readdirSync(ALBUMS_DIR)
    .map(readAlbum)
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function deleteAlbum(id) {
  fs.rmSync(albumDir(id), { recursive: true, force: true });
}

export function summary(a) {
  const done = a.items.filter((i) => i.status === 'done');
  return {
    id: a.id, url: a.url, title: a.title, author: a.author, createdAt: a.createdAt,
    status: a.status, error: a.error || null,
    total: a.items.length, done: done.length,
    videos: a.items.filter((i) => i.type !== 'image').length,
    images: a.items.filter((i) => i.type === 'image').length,
    bytes: done.reduce((s, i) => s + (i.size || 0), 0),
    thumb: a.thumb || done.find((i) => i.type === 'image')?.file || null,
  };
}
