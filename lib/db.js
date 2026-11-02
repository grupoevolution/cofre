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

// migrações simples de colunas novas
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('folders').includes('parent_id')) db.exec('ALTER TABLE folders ADD COLUMN parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE');
if (!cols('imports').includes('kind')) db.exec("ALTER TABLE imports ADD COLUMN kind TEXT NOT NULL DEFAULT 'erome'");

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

/**
 * Cria pasta (ou subpasta). O "slug" é o caminho completo no Bunny Storage:
 * "chats" para a pasta principal, "chats/fulana" para a subpasta.
 */
export function createFolder(name, parentId = null) {
  name = String(name || '').trim().replace(/[\/]+/g, '-').slice(0, 80);
  if (!name) throw new Error('Dê um nome para a pasta.');
  const parent = parentId ? getFolder(parentId) : null;
  if (parentId && !parent) throw new Error('Pasta mãe não encontrada.');
  const prefix = parent ? parent.slug + '/' : '';
  let base = prefix + (slugify(name) || 'pasta'), slug = base, n = 2;
  while (one('SELECT 1 FROM folders WHERE slug = ?', slug)) slug = `${base}-${n++}`;
  const r = run('INSERT INTO folders (name, slug, parent_id, created_at) VALUES (?, ?, ?, ?)', name, slug, parent?.id ?? null, now());
  return getFolder(Number(r.lastInsertRowid));
}

/** Ids da pasta e de todas as subpastas (em qualquer nível). */
export function subtreeIds(folderId) {
  return all(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
    SELECT id FROM t`, Number(folderId)).map((r) => r.id);
}

/** Nomes do caminho, da pasta principal até esta: ["Chats", "Fulana"] */
export function folderTrail(folderId) {
  return all(`WITH RECURSIVE t(id, name, parent_id, d) AS (
      SELECT id, name, parent_id, 0 FROM folders WHERE id = ?
      UNION ALL SELECT f.id, f.name, f.parent_id, t.d + 1 FROM folders f JOIN t ON f.id = t.parent_id)
    SELECT id, name FROM t ORDER BY d DESC`, Number(folderId));
}

// Garante nome único dentro da pasta (inclusive entre os que já foram para o Bunny)
export function uniqueName(folderId, base, ext, exceptId = 0) {
  let name = `${base}.${ext}`, n = 2;
  while (one('SELECT 1 FROM media WHERE folder_id = ? AND name = ? AND id != ?', folderId, name, exceptId)) {
    name = `${base}-${n++}.${ext}`;
  }
  return name;
}

export function folderStats(folderIds) {
  const ids = [].concat(folderIds);
  return one(`SELECT
    SUM(local_deleted = 0) AS local,
    SUM(local_deleted = 0 AND status = 'ready') AS ready,
    SUM(status IN ('queued','downloading','edit_queued','editing','fix_queued','fixing')) AS busy,
    SUM(status = 'error' AND local_deleted = 0) AS errors,
    SUM(bunny_status = 'sent') AS sent,
    SUM(bunny_status = 'sent' AND local_deleted = 0) AS freeable,
    SUM(bunny_status IN ('queued','uploading','verifying')) AS sending,
    SUM(CASE WHEN local_deleted = 0 THEN COALESCE(size, 0) ELSE 0 END) AS bytes
    FROM media WHERE folder_id IN (${ids.map(() => '?').join(',')})`, ...ids);
}
