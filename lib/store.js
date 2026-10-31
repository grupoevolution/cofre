import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const ALBUMS_DIR = path.join(DATA_DIR, 'albums');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
fs.mkdirSync(ALBUMS_DIR, { recursive: true });

// "Álbum" = uma fonte baixada (um link colado). Os arquivos ficam em /data/albums/<id>/.
// Tudo fica em memória e é gravado em meta.json a cada mudança (uso pessoal: milhares de arquivos, sem banco).

export const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '');
export const albumDir = (id) => path.join(ALBUMS_DIR, safeId(id));
const metaPath = (id) => path.join(albumDir(id), 'meta.json');

const cache = new Map();
for (const d of fs.readdirSync(ALBUMS_DIR)) {
  try {
    const a = JSON.parse(fs.readFileSync(metaPath(d), 'utf8'));
    a.items ||= [];
    cache.set(a.id, a);
  } catch { /* pasta sem meta.json: ignora */ }
}

export function readAlbum(id) { return cache.get(safeId(id)) || null; }

export function writeAlbum(album) {
  cache.set(album.id, album);
  fs.mkdirSync(albumDir(album.id), { recursive: true });
  const tmp = metaPath(album.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(album, null, 1));
  fs.renameSync(tmp, metaPath(album.id));
}

export function listAlbums() {
  return [...cache.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function deleteAlbum(id) {
  const a = readAlbum(id);
  if (a) for (const it of a.items) if (it.hash && hashIndex.get(it.hash) === itemKey(a, it)) hashIndex.delete(it.hash);
  cache.delete(safeId(id));
  fs.rmSync(albumDir(id), { recursive: true, force: true });
}

// ---------- Itens ----------
export const VISIBLE = (it) => it.status !== 'deleted' && it.status !== 'duplicate';
export const itemKey = (a, it) => `${a.id}/${it.file}`;

export function findItem(key) {
  const [id, ...rest] = String(key).split('/');
  const a = readAlbum(id);
  const file = rest.join('/');
  const it = a?.items.find((i) => i.file === file);
  return it ? { album: a, item: it } : null;
}

export function* allItems() {
  for (const a of listAlbums()) for (const it of a.items) yield { album: a, item: it };
}

export const orientation = (it) => {
  if (!it.width || !it.height) return null;
  const r = it.width / it.height;
  return r > 1.1 ? 'h' : r < 0.9 ? 'v' : 'q';
};

export function publicItem(a, it) {
  const base = `/files/${a.id}/`;
  const local = it.local !== false;
  return {
    id: itemKey(a, it), album: a.id, albumTitle: a.title || a.site || a.id, site: a.site || '',
    file: it.file, type: it.type, status: it.status, error: it.error || null,
    size: it.size || 0, width: it.width || null, height: it.height || null, duration: it.duration || null,
    orient: orientation(it), title: it.title || '',
    src: local ? base + encodeURIComponent(it.file) : it.bunny?.url || null,
    thumb: it.thumb ? base + encodeURIComponent(it.thumb) : null,
    local, used: !!it.used, folders: it.folders || [],
    bunny: it.bunny ? { status: it.bunny.status, url: it.bunny.url || null, error: it.bunny.error || null } : null,
    addedAt: it.addedAt || a.createdAt,
  };
}

// ---------- Anti-duplicado (impressão digital SHA-256 do arquivo original) ----------
export const hashIndex = new Map();
for (const { album, item } of allItems()) {
  if (item.hash && item.status === 'done' && !hashIndex.has(item.hash)) hashIndex.set(item.hash, itemKey(album, item));
}

export function unindexItem(a, it) {
  if (it.hash && hashIndex.get(it.hash) === itemKey(a, it)) hashIndex.delete(it.hash);
}

// ---------- Resumo da fonte ----------
export function summary(a) {
  const vis = a.items.filter(VISIBLE);
  const done = vis.filter((i) => i.status === 'done');
  const thumbItem = done.find((i) => i.type === 'image' && i.local !== false) || done.find((i) => i.thumb);
  return {
    id: a.id, url: a.url, kind: a.kind || 'erome', site: a.site || 'erome.com',
    title: a.title, author: a.author, createdAt: a.createdAt,
    status: a.status, error: a.error || null, note: a.note || null, progress: a.progress || null,
    hint: a.hint || null, errorCode: a.errorCode || null, errorDetail: a.errorDetail || null,
    total: vis.length, done: done.length,
    duplicates: a.items.filter((i) => i.status === 'duplicate').length,
    videos: vis.filter((i) => i.type === 'video' || i.type === 'hls').length,
    images: vis.filter((i) => i.type === 'image').length,
    bytes: done.reduce((s, i) => s + (i.local !== false ? i.size || 0 : 0), 0),
    thumb: thumbItem ? `/files/${a.id}/${encodeURIComponent(thumbItem.type === 'image' ? thumbItem.file : thumbItem.thumb)}` : null,
    folderIds: a.folderIds || [],
  };
}

// ---------- Pastas ----------
let library = { folders: [] };
try { library = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); } catch { /* primeira vez */ }
library.folders ||= [];
const saveLibrary = () => {
  fs.writeFileSync(LIBRARY_FILE + '.tmp', JSON.stringify(library, null, 1));
  fs.renameSync(LIBRARY_FILE + '.tmp', LIBRARY_FILE);
};

export const listFolders = () => library.folders;
export const getFolder = (id) => library.folders.find((f) => f.id === id) || null;

export function createFolder(name) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new Error('Dê um nome para a pasta');
  const existing = library.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const f = { id: crypto.randomBytes(5).toString('hex'), name, createdAt: new Date().toISOString() };
  library.folders.push(f);
  saveLibrary();
  return f;
}

export function renameFolder(id, name) {
  const f = getFolder(id);
  if (!f) return null;
  name = String(name || '').trim().slice(0, 80);
  if (name) { f.name = name; saveLibrary(); }
  return f;
}

export function deleteFolder(id) {
  library.folders = library.folders.filter((f) => f.id !== id);
  saveLibrary();
  for (const a of listAlbums()) {
    let changed = false;
    if (a.folderIds?.includes(id)) { a.folderIds = a.folderIds.filter((x) => x !== id); changed = true; }
    for (const it of a.items) if (it.folders?.includes(id)) { it.folders = it.folders.filter((x) => x !== id); changed = true; }
    if (changed) writeAlbum(a);
  }
}
