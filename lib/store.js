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

/** Etapa do arquivo no caminho até o app: bruto → selecionado → no Bunny → usado. */
export const stageOf = (it) => (it.used ? 'usado' : it.bunny?.status === 'done' ? 'bunny' : it.approved ? 'selecionado' : 'bruto');

// as legendas vêm de lib/tags.js (registrado lá para evitar import circular)
let tagsOf = (it) => it.tags || [];
export const setTagsResolver = (fn) => { tagsOf = fn; };

export function publicItem(a, it) {
  const base = `/files/${a.id}/`;
  const local = it.local !== false;
  const sim = it.similarTo && !it.similarIgnored ? findItem(it.similarTo) : null;
  return {
    fav: !!it.fav, approved: !!it.approved, stage: stageOf(it),
    tags: tagsOf(it), autoTags: it.autoTags || null, tagsEdited: !!it.tagsEdited,
    usedIn: it.usedIn || [],
    similarTo: sim && sim.item.status === 'done' ? it.similarTo : null,
    sprite: it.sprite ? base + encodeURIComponent(it.sprite) : null,
    clipOf: it.clipOf || null, frameOf: it.frameOf || null, frameAt: it.frameAt ?? null, kitOf: it.kitOf || null, kit: it.kit || null,
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
  visualIndex.delete(itemKey(a, it));
}

// ---------- Quase-duplicado (impressão visual) ----------
export const visualIndex = new Map(); // chave -> { hash, type }
for (const { album, item } of allItems()) {
  if (item.phash && item.status === 'done') visualIndex.set(itemKey(album, item), { hash: item.phash, type: item.type });
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
    folderIds: a.folderIds || [], parent: a.parent || null,
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

// Pasta "persona" = uma mulher do app. O Cofre avisa se o mesmo arquivo for parar em duas personas.
export function createFolder(name, { persona = false, appName = '' } = {}) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new Error('Dê um nome para a pasta');
  const existing = library.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const f = { id: crypto.randomBytes(5).toString('hex'), name, persona: !!persona, appName: String(appName || '').slice(0, 80), createdAt: new Date().toISOString() };
  library.folders.push(f);
  saveLibrary();
  return f;
}

export function updateFolder(id, { name, persona, appName, note } = {}) {
  const f = getFolder(id);
  if (!f) return null;
  if (name != null && String(name).trim()) f.name = String(name).trim().slice(0, 80);
  if (persona != null) f.persona = !!persona;
  if (appName != null) f.appName = String(appName).slice(0, 80);
  if (note != null) f.note = String(note).slice(0, 500);
  saveLibrary();
  return f;
}
export const renameFolder = (id, name) => updateFolder(id, { name });
export const personaIds = () => new Set(library.folders.filter((f) => f.persona).map((f) => f.id));

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
