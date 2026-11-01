import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'cofre.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  dest TEXT NOT NULL DEFAULT 'auto',          -- auto | storage | stream
  stream_collection_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source_id TEXT,
  title TEXT, author TEXT,
  status TEXT NOT NULL,                        -- queued | parsing | parsed | error
  error TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  position INTEGER,
  parent_id INTEGER,
  type TEXT NOT NULL,                          -- image | video
  source_url TEXT,
  source_kind TEXT NOT NULL,                   -- http | hls | edit | legacy
  edit_spec TEXT,
  name TEXT NOT NULL,                          -- nome "bonito" (vai para o Bunny e para o download)
  ext TEXT NOT NULL,
  file TEXT,                                   -- arquivo local em /data/media
  thumb TEXT,                                  -- miniatura em /data/thumbs (fica mesmo após liberar espaço)
  size INTEGER, duration REAL, width INTEGER, height INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,                        -- queued | downloading | edit_queued | editing | ready | error
  error TEXT,
  local_deleted INTEGER NOT NULL DEFAULT 0,    -- 1 = arquivo apagado da VPS (já estava no Bunny)
  bunny_status TEXT,                           -- NULL | queued | uploading | verifying | sent | error
  bunny_target TEXT,                           -- storage | stream
  bunny_path TEXT, bunny_video_id TEXT, bunny_url TEXT, bunny_error TEXT, sent_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_folder ON media(folder_id);
CREATE INDEX IF NOT EXISTS media_status ON media(status);
CREATE INDEX IF NOT EXISTS media_bunny ON media(bunny_status);

CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

export const now = () => new Date().toISOString();
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Atualiza colunas de uma mídia: setMedia(id, { status: 'ready', size: 10 })
export function setMedia(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE media SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => fields[k] ?? null), now(), id);
}
export const getMedia = (id) => one('SELECT * FROM media WHERE id = ?', id);
export const getFolder = (id) => one('SELECT * FROM folders WHERE id = ?', id);

export const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60);

export function createFolder(name) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new Error('Dê um nome para a pasta.');
  let base = slugify(name) || 'pasta', slug = base, n = 2;
  while (one('SELECT 1 FROM folders WHERE slug = ?', slug)) slug = `${base}-${n++}`;
  const r = run('INSERT INTO folders (name, slug, created_at) VALUES (?, ?, ?)', name, slug, now());
  return getFolder(Number(r.lastInsertRowid));
}

// Garante nome único dentro da pasta (inclusive entre os que já foram para o Bunny)
export function uniqueName(folderId, base, ext, exceptId = 0) {
  let name = `${base}.${ext}`, n = 2;
  while (one('SELECT 1 FROM media WHERE folder_id = ? AND name = ? AND id != ?', folderId, name, exceptId)) {
    name = `${base}-${n++}.${ext}`;
  }
  return name;
}

export function folderStats(folderId) {
  return one(`SELECT
    SUM(local_deleted = 0) AS local,
    SUM(local_deleted = 0 AND status = 'ready') AS ready,
    SUM(status IN ('queued','downloading','edit_queued','editing')) AS busy,
    SUM(status = 'error' AND local_deleted = 0) AS errors,
    SUM(bunny_status = 'sent') AS sent,
    SUM(bunny_status = 'sent' AND local_deleted = 0) AS freeable,
    SUM(bunny_status IN ('queued','uploading','verifying')) AS sending,
    SUM(CASE WHEN local_deleted = 0 THEN COALESCE(size, 0) ELSE 0 END) AS bytes
    FROM media WHERE folder_id = ?`, folderId);
}
