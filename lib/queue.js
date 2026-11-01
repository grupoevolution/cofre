import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, BUNNY, MEDIA_DIR, THUMB_DIR, TMP_DIR, diskFree } from './config.js';
import { one, all, run, tx, now, setMedia, getMedia, getFolder, slugify, uniqueName } from './db.js';
import { changedFolder, setProgress, clearProgress } from './bus.js';
import { fetchAlbumPage, parseAlbum, mediaHeaders } from './erome.js';
import { downloadToFile, hashFile } from './net.js';
import { ffmpegSlot, run as runCmd, probe, makeThumb, downloadHls } from './ffmpeg.js';
import { buildEdit } from './editor.js';
import * as bunny from './bunny.js';

export const localPath = (m) => path.join(MEDIA_DIR, m.file || `${m.id}.${m.ext}`);
export const thumbPath = (m) => (m.thumb ? path.join(THUMB_DIR, m.thumb) : null);

const controllers = new Map(); // mediaId -> AbortController (para cancelar ao apagar)
export const state = { paused: null };

// ---------- Pool: no máximo N tarefas de um tipo ao mesmo tempo; o resto espera na fila ----------
class Pool {
  constructor(name, limit, claim, work) { Object.assign(this, { name, limit, claim, work, active: 0 }); }
  pump() {
    while (this.active < this.limit) {
      const job = this.claim();
      if (!job) return;
      this.active++;
      Promise.resolve().then(() => this.work(job))
        .catch((e) => console.error(`[${this.name}]`, e))
        .finally(() => { this.active--; this.pump(); });
    }
  }
}

function diskOk() {
  const ok = diskFree().free >= LIMITS.minFreeBytes;
  const was = state.paused;
  state.paused = ok ? null : 'disk';
  if (was !== state.paused) changedFolder(0);
  return ok;
}

const pools = {
  imports: new Pool('import', LIMITS.imports, () => {
    const imp = one("SELECT * FROM imports WHERE status = 'queued' ORDER BY id LIMIT 1");
    if (imp) run("UPDATE imports SET status = 'parsing', error = NULL WHERE id = ?", imp.id);
    return imp;
  }, doImport),
  downloads: new Pool('download', LIMITS.downloads, () => {
    if (!one("SELECT 1 FROM media WHERE status = 'queued'") || !diskOk()) return null;
    const m = one("SELECT * FROM media WHERE status = 'queued' ORDER BY id LIMIT 1");
    if (m) setMedia(m.id, { status: 'downloading', error: null });
    return m;
  }, doDownload),
  edits: new Pool('edit', LIMITS.ffmpeg, () => {
    if (!one("SELECT 1 FROM media WHERE status = 'edit_queued'") || !diskOk()) return null;
    const m = one("SELECT * FROM media WHERE status = 'edit_queued' ORDER BY id LIMIT 1");
    if (m) setMedia(m.id, { status: 'editing', error: null });
    return m;
  }, doEdit),
  uploads: new Pool('upload', LIMITS.uploads, () => {
    const m = one(`SELECT * FROM media WHERE bunny_status = 'queued' AND status = 'ready' AND local_deleted = 0
      ORDER BY sent_at IS NOT NULL, id LIMIT 1`);
    if (m) setMedia(m.id, { bunny_status: 'uploading', bunny_error: null });
    return m;
  }, doUpload),
};

export function kick() { for (const p of Object.values(pools)) p.pump(); }

export function activeCounts() {
  return Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, p.active]));
}

// Ao reiniciar o servidor: o que estava "em andamento" volta para a fila.
export function boot() {
  run("UPDATE imports SET status = 'queued' WHERE status = 'parsing'");
  run("UPDATE media SET status = 'queued' WHERE status = 'downloading'");
  run("UPDATE media SET status = 'edit_queued' WHERE status = 'editing'");
  run("UPDATE media SET bunny_status = 'queued' WHERE bunny_status = 'uploading' OR (bunny_status = 'verifying' AND bunny_target = 'storage')");
  for (const f of fs.readdirSync(MEDIA_DIR)) if (f.endsWith('.part') || f.includes('.part.')) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
  fs.rmSync(TMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TMP_DIR, { recursive: true });
  setInterval(kick, 10_000).unref();
  setInterval(verifyStream, 15_000).unref();
  kick();
  backfillThumbs();
}

async function withRetry(fn, tries, signal) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (signal?.aborted || /\b(401|403|404)\b/.test(e.message)) break;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const extFrom = (url, type) => {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  if (m && type !== 'hls') return m[1].toLowerCase().replace('jpeg', 'jpg');
  return type === 'image' ? 'jpg' : 'mp4';
};

// ---------- 1) Ler a página do álbum e criar as mídias ----------
const pageCache = new Map(); // importId -> { at, items } (para renovar links que expiraram)

async function doImport(imp) {
  try {
    const html = await withRetry(() => fetchAlbumPage(imp.url), 3);
    const parsed = parseAlbum(html, imp.url);
    if (!parsed.items.length) throw new Error('Nenhum vídeo ou imagem encontrado (álbum privado, removido ou o site mudou).');
    pageCache.set(imp.id, { at: Date.now(), items: parsed.items });
    const pad = Math.max(3, String(parsed.items.length).length);
    const who = slugify(parsed.author) || 'erome';
    tx(() => {
      parsed.items.forEach((it, i) => {
        if (one('SELECT 1 FROM media WHERE import_id = ? AND position = ?', imp.id, i)) return;
        const ext = extFrom(it.url, it.type);
        const name = uniqueName(imp.folder_id, `${who}_${imp.source_id}_${String(i + 1).padStart(pad, '0')}`, ext);
        run(`INSERT INTO media (folder_id, import_id, position, type, source_url, source_kind, name, ext, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`, imp.folder_id, imp.id, i, it.type === 'image' ? 'image' : 'video',
          it.url, it.type === 'hls' ? 'hls' : 'http', name, ext, now(), now());
      });
      run("UPDATE imports SET title = ?, author = ?, total = ?, status = 'parsed', finished_at = ? WHERE id = ?",
        parsed.title, parsed.author, parsed.items.length, now(), imp.id);
    });
  } catch (e) {
    run("UPDATE imports SET status = 'error', error = ?, finished_at = ? WHERE id = ?", String(e.message || e), now(), imp.id);
  }
  changedFolder(imp.folder_id);
  kick();
}

async function freshUrl(m) {
  const imp = one('SELECT * FROM imports WHERE id = ?', m.import_id);
  if (!imp) return null;
  let c = pageCache.get(imp.id);
  if (!c || Date.now() - c.at > 10 * 60_000) {
    try { c = { at: Date.now(), items: parseAlbum(await fetchAlbumPage(imp.url), imp.url).items }; pageCache.set(imp.id, c); }
    catch { return null; }
  }
  return c.items[m.position]?.url || null;
}

// ---------- 2) Baixar ----------
async function doDownload(m) {
  const ctrl = new AbortController();
  controllers.set(m.id, ctrl);
  const dest = path.join(MEDIA_DIR, `${m.id}.${m.ext}`);
  changedFolder(m.folder_id);
  try {
    let url = m.source_url, refreshed = false, result;
    const once = async () => {
      if (m.source_kind === 'hls') { await downloadHls(url, dest, ctrl.signal); return { size: fs.statSync(dest).size, sha256: await hashFile(dest) }; }
      return downloadToFile(url, dest, { headers: mediaHeaders(), signal: ctrl.signal, onProgress: (g, t) => setProgress(m.id, 'dl', g, t) });
    };
    for (;;) {
      try { result = await withRetry(once, 3, ctrl.signal); break; } catch (e) {
        if (ctrl.signal.aborted || refreshed || !m.import_id) throw e;
        refreshed = true; // o link pode ter expirado: relê a página do álbum e tenta com o link novo
        const nu = await freshUrl(m);
        if (!nu || nu === url) throw e;
        url = nu; setMedia(m.id, { source_url: nu });
      }
    }
    if (!getMedia(m.id)) { fs.rmSync(dest, { force: true }); return; } // apagado no meio do download
    const info = await probe(dest);
    const thumb = `${m.id}.jpg`;
    const hasThumb = await makeThumb(dest, m.type, path.join(THUMB_DIR, thumb));
    setMedia(m.id, { status: 'ready', file: `${m.id}.${m.ext}`, size: result.size, sha256: result.sha256,
      width: info.width, height: info.height, duration: m.type === 'video' ? info.duration : null,
      thumb: hasThumb ? thumb : null, error: null });
  } catch (e) {
    fs.rmSync(dest, { force: true });
    if (getMedia(m.id)) setMedia(m.id, { status: 'error', error: String(e.message || e) });
  } finally {
    controllers.delete(m.id); clearProgress(m.id); changedFolder(m.folder_id);
  }
}

// ---------- 3) Editar (gera uma cópia) ----------
async function doEdit(m) {
  const ctrl = new AbortController();
  controllers.set(m.id, ctrl);
  changedFolder(m.folder_id);
  const tmp = path.join(TMP_DIR, `edit-${m.id}.${m.ext}`);
  try {
    const parent = getMedia(m.parent_id);
    if (!parent || parent.local_deleted || parent.status !== 'ready') throw new Error('O arquivo original não está mais no sistema.');
    const src = localPath(parent);
    const info = await probe(src);
    const { args } = buildEdit(JSON.parse(m.edit_spec), { ...parent, ...info, type: parent.type, ext: parent.ext }, src, tmp);
    await ffmpegSlot.use(() => runCmd('ffmpeg', args, { timeoutMs: 45 * 60_000, signal: ctrl.signal, nice: true }));
    if (!getMedia(m.id)) return;
    const dest = path.join(MEDIA_DIR, `${m.id}.${m.ext}`);
    fs.renameSync(tmp, dest);
    const out = await probe(dest);
    const thumb = `${m.id}.jpg`;
    const hasThumb = await makeThumb(dest, m.type, path.join(THUMB_DIR, thumb));
    setMedia(m.id, { status: 'ready', file: `${m.id}.${m.ext}`, size: fs.statSync(dest).size, sha256: await hashFile(dest),
      width: out.width, height: out.height, duration: m.type === 'video' ? out.duration : null, thumb: hasThumb ? thumb : null, error: null });
  } catch (e) {
    if (getMedia(m.id)) setMedia(m.id, { status: 'error', error: 'Edição falhou: ' + String(e.message || e) });
  } finally {
    fs.rmSync(tmp, { force: true });
    controllers.delete(m.id); changedFolder(m.folder_id);
  }
}

// ---------- 4) Enviar ao Bunny ----------

/**
 * Para onde vai cada mídia:
 * - fotos → sempre Storage;
 * - vídeos → Stream se a pasta é "só de vídeo" (nunca teve foto e nenhum vídeo dela foi para o Storage);
 *   senão Storage, para a pasta ficar inteira num lugar só. A pasta pode forçar Storage ou Stream.
 */
export function resolveTarget(m, folder) {
  let target;
  if (m.type === 'image') target = 'storage';
  else if (folder.dest === 'storage' || folder.dest === 'stream') target = folder.dest;
  else {
    const mixed = one(`SELECT 1 FROM media WHERE folder_id = ? AND (type = 'image'
      OR (type = 'video' AND bunny_target = 'storage' AND bunny_status IS NOT NULL)) LIMIT 1`, folder.id);
    target = mixed ? 'storage' : 'stream';
  }
  if (target === 'stream' && !BUNNY.stream.enabled && BUNNY.storage.enabled) target = 'storage';
  if (target === 'storage' && !BUNNY.storage.enabled && m.type === 'video' && BUNNY.stream.enabled) target = 'stream';
  return BUNNY[target].enabled ? target : null;
}

const collectionLocks = new Map();
async function ensureCollection(folderId, reset = false) {
  if (reset) run('UPDATE folders SET stream_collection_id = NULL WHERE id = ?', folderId);
  const f = getFolder(folderId);
  if (f.stream_collection_id) return f.stream_collection_id;
  if (!collectionLocks.has(folderId)) {
    collectionLocks.set(folderId, bunny.streamCreateCollection(f.name)
      .then((guid) => { run('UPDATE folders SET stream_collection_id = ? WHERE id = ?', guid, folderId); return guid; })
      .finally(() => collectionLocks.delete(folderId)));
  }
  return collectionLocks.get(folderId);
}

async function doUpload(m) {
  const ctrl = new AbortController();
  controllers.set(m.id, ctrl);
  changedFolder(m.folder_id);
  try {
    const folder = getFolder(m.folder_id);
    const file = localPath(m);
    if (!fs.existsSync(file)) throw new Error('O arquivo não está mais no sistema.');
    const size = fs.statSync(file).size;
    let sha256 = m.sha256;
    if (!sha256) { sha256 = await hashFile(file); setMedia(m.id, { sha256 }); }
    const onProgress = (g, t) => setProgress(m.id, 'up', g, t);

    if (m.bunny_target === 'stream') {
      let guid = m.bunny_video_id;
      if (guid) { // tentativa anterior: reaproveita o vídeo vazio, se ainda existir
        const v = await bunny.streamGet(guid).catch(() => ({ missing: true }));
        if (v.missing || v.status !== 0) guid = null;
      }
      if (!guid) {
        let col = await ensureCollection(folder.id);
        try { guid = await bunny.streamCreateVideo(m.name, col); } catch (e) {
          if (!e.collection) throw e;
          col = await ensureCollection(folder.id, true);
          guid = await bunny.streamCreateVideo(m.name, col);
        }
        setMedia(m.id, { bunny_video_id: guid });
      }
      await withRetry(() => bunny.streamUpload({ guid, file, onProgress, signal: ctrl.signal }), 2, ctrl.signal);
      setMedia(m.id, { bunny_status: 'verifying', bunny_path: `${folder.name}/${m.name}`, bunny_url: bunny.streamUrl(guid) });
      // a confirmação final vem do verifyStream() quando o Bunny terminar de processar
    } else {
      const remotePath = `${folder.slug}/${m.name}`;
      await withRetry(() => bunny.storageUpload({ file, remotePath, sha256, ext: m.ext, onProgress, signal: ctrl.signal }), 2, ctrl.signal);
      setMedia(m.id, { bunny_status: 'verifying' });
      const problem = bunny.storageCheck(await bunny.storageList(folder.slug), remotePath, size, sha256);
      if (problem) throw new Error(problem);
      setMedia(m.id, { bunny_status: 'sent', bunny_path: remotePath, bunny_url: bunny.storageUrl(remotePath), sent_at: now(), bunny_error: null });
    }
  } catch (e) {
    if (getMedia(m.id)) setMedia(m.id, { bunny_status: 'error', bunny_error: String(e.message || e) });
  } finally {
    controllers.delete(m.id); clearProgress(m.id); changedFolder(m.folder_id);
  }
}

let verifying = false;
async function verifyStream() {
  if (verifying || !BUNNY.stream.enabled) return;
  verifying = true;
  try {
    for (const m of all("SELECT * FROM media WHERE bunny_status = 'verifying' AND bunny_target = 'stream' ORDER BY updated_at LIMIT 20")) {
      try {
        const v = await bunny.streamGet(m.bunny_video_id);
        if (v.missing) setMedia(m.id, { bunny_status: 'error', bunny_error: 'O vídeo não existe mais no Bunny Stream.' });
        else if (v.status === 4) setMedia(m.id, { bunny_status: 'sent', sent_at: now(), bunny_error: null });
        else if (v.status === 5 || v.status === 6) setMedia(m.id, { bunny_status: 'error', bunny_error: 'O Bunny não conseguiu processar o vídeo.' });
        else continue;
        changedFolder(m.folder_id);
      } catch { /* sem conexão agora: tenta na próxima rodada */ }
    }
  } finally { verifying = false; }
}

/** Coloca mídias na fila de envio. Devolve quantas entraram e quantas foram ignoradas (e por quê). */
export function queueSend(ids) {
  let queued = 0; const skipped = [];
  for (const id of ids) {
    const m = getMedia(id);
    if (!m) continue;
    if (m.status !== 'ready' || m.local_deleted) { skipped.push(`${m.name}: ainda não está pronta`); continue; }
    if (['queued', 'uploading', 'verifying', 'sent'].includes(m.bunny_status)) continue;
    const target = resolveTarget(m, getFolder(m.folder_id));
    if (!target) { skipped.push(`${m.name}: Bunny ${m.type === 'image' ? 'Storage' : ''} não configurado`); continue; }
    setMedia(id, { bunny_status: 'queued', bunny_target: target, bunny_error: null });
    queued++;
    changedFolder(m.folder_id);
  }
  kick();
  return { queued, skipped };
}

// ---------- 5) Liberar espaço: só apaga o que foi conferido no Bunny agora ----------
export async function freeSpace(ids) {
  const items = ids.map(getMedia).filter((m) => m && m.bunny_status === 'sent' && !m.local_deleted);
  const listings = new Map();
  let freed = 0, bytes = 0; const failed = [];
  for (const m of items) {
    let problem = null;
    try {
      if (m.bunny_target === 'stream') {
        const v = await bunny.streamGet(m.bunny_video_id);
        problem = v.missing ? 'não encontrado no Bunny Stream' : v.status !== 4 ? 'vídeo ainda não está pronto no Bunny' : null;
      } else {
        const dir = path.posix.dirname(m.bunny_path);
        if (!listings.has(dir)) listings.set(dir, await bunny.storageList(dir));
        problem = bunny.storageCheck(listings.get(dir), m.bunny_path, m.size, m.sha256);
      }
    } catch (e) { failed.push({ name: m.name, reason: 'não deu para conferir agora: ' + e.message }); continue; }
    if (problem) {
      setMedia(m.id, { bunny_status: 'error', bunny_error: problem });
      failed.push({ name: m.name, reason: problem });
      continue;
    }
    fs.rmSync(localPath(m), { force: true });
    setMedia(m.id, { local_deleted: 1, file: null });
    freed++; bytes += m.size || 0;
    changedFolder(m.folder_id);
  }
  return { freed, bytes, failed };
}

// ---------- Apagar do sistema (não mexe no Bunny) ----------
export function deleteMedia(m) {
  controllers.get(m.id)?.abort();
  if (m.file) fs.rmSync(localPath(m), { force: true });
  fs.rmSync(path.join(MEDIA_DIR, `${m.id}.${m.ext}.part`), { force: true });
  if (m.thumb) fs.rmSync(path.join(THUMB_DIR, m.thumb), { force: true });
  run('DELETE FROM media WHERE id = ?', m.id);
  changedFolder(m.folder_id);
}

async function backfillThumbs() {
  for (const m of all("SELECT * FROM media WHERE status = 'ready' AND local_deleted = 0 AND thumb IS NULL")) {
    const thumb = `${m.id}.jpg`;
    if (await makeThumb(localPath(m), m.type, path.join(THUMB_DIR, thumb))) {
      const info = await probe(localPath(m));
      setMedia(m.id, { thumb, width: info.width, height: info.height, duration: m.type === 'video' ? info.duration : null });
      changedFolder(m.folder_id);
    }
  }
}
