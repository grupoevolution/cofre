import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { PORT, PIN, IS_PROD, LIMITS, BUNNY, diskFree } from './lib/config.js';
import { one, all, run, now, getMedia, getFolder, createFolder, uniqueName, folderStats, setMedia } from './lib/db.js';
import { authed, login, logout, logoutAll, requireAuth } from './lib/auth.js';
import { albumUrlsFromText, extractUrl } from './lib/erome.js';
import { bus, progress, changedFolder } from './lib/bus.js';
import { cleanSpec, buildEdit } from './lib/editor.js';
import { migrateLegacy } from './lib/migrate.js';
import * as queue from './lib/queue.js';

if (IS_PROD && !PIN) {
  console.error('APP_PIN não definido. Defina APP_PIN nas variáveis de ambiente para proteger o Cofre.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // um proxy na frente (EasyPanel/Traefik)
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const ids = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map(Number).filter((n) => n > 0))];

// ---------- Login ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) => res.json({ authed: authed(req), pin: Boolean(PIN) }));
app.use(['/api', '/media', '/thumb'], requireAuth);
app.post('/api/logout-all', logoutAll);

// ---------- Situação geral ----------
app.get('/api/status', (req, res) => {
  const q = one(`SELECT SUM(status = 'queued') AS downloads, SUM(status = 'edit_queued') AS edits,
    SUM(bunny_status = 'queued') AS uploads, SUM(bunny_status = 'verifying') AS verifying FROM media`);
  res.json({
    disk: diskFree(), paused: queue.state.paused, minFree: LIMITS.minFreeBytes,
    active: queue.activeCounts(), waiting: q, limits: LIMITS,
    imports: one("SELECT COUNT(*) AS n FROM imports WHERE status IN ('queued','parsing')").n,
    bunny: { storage: BUNNY.storage.enabled, stream: BUNNY.stream.enabled },
  });
});

// ---------- Pastas ----------
const folderDto = (f) => ({
  ...f, stats: folderStats(f.id),
  cover: one('SELECT id FROM media WHERE folder_id = ? AND thumb IS NOT NULL ORDER BY id DESC LIMIT 1', f.id)?.id || null,
});

app.get('/api/folders', (req, res) => {
  res.json(all(`SELECT f.* FROM folders f LEFT JOIN media m ON m.folder_id = f.id
    GROUP BY f.id ORDER BY MAX(COALESCE(m.created_at, f.created_at)) DESC`).map(folderDto));
});

app.post('/api/folders', (req, res) => {
  try { res.status(201).json(folderDto(createFolder(req.body?.name))); } catch (e) { bad(res, e.message); }
});

app.patch('/api/folders/:id', (req, res) => {
  const f = getFolder(req.params.id);
  if (!f) return bad(res, 'Pasta não encontrada', 404);
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 80);
    if (!name) return bad(res, 'Dê um nome para a pasta.');
    run('UPDATE folders SET name = ? WHERE id = ?', name, f.id); // o caminho no Bunny (slug) continua o mesmo
  }
  if (req.body?.dest !== undefined) {
    if (!['auto', 'storage', 'stream'].includes(req.body.dest)) return bad(res, 'Destino inválido');
    run('UPDATE folders SET dest = ? WHERE id = ?', req.body.dest, f.id);
  }
  changedFolder(f.id);
  res.json(folderDto(getFolder(f.id)));
});

app.delete('/api/folders/:id', (req, res) => {
  const f = getFolder(req.params.id);
  if (!f) return bad(res, 'Pasta não encontrada', 404);
  for (const m of all('SELECT * FROM media WHERE folder_id = ?', f.id)) queue.deleteMedia(m);
  run('DELETE FROM folders WHERE id = ?', f.id);
  changedFolder(0);
  res.json({ ok: true });
});

const mediaDto = (m) => ({
  id: m.id, folder_id: m.folder_id, import_id: m.import_id, parent_id: m.parent_id, type: m.type, name: m.name, ext: m.ext,
  size: m.size, duration: m.duration, width: m.width, height: m.height, status: m.status, error: m.error,
  local: !m.local_deleted, thumb: Boolean(m.thumb), created_at: m.created_at, edited: m.source_kind === 'edit',
  bunny_status: m.bunny_status, bunny_target: m.bunny_target, bunny_url: m.bunny_url, bunny_path: m.bunny_path,
  bunny_error: m.bunny_error, sent_at: m.sent_at, progress: progress.get(m.id) || null,
});

app.get('/api/folders/:id', (req, res) => {
  const f = getFolder(req.params.id);
  if (!f) return bad(res, 'Pasta não encontrada', 404);
  res.json({
    ...folderDto(f),
    media: all('SELECT * FROM media WHERE folder_id = ? ORDER BY id DESC', f.id).map(mediaDto),
    imports: importsList('WHERE i.folder_id = ?', f.id),
  });
});

// ---------- Links (importações) ----------
function importsList(where, ...p) {
  return all(`SELECT i.id, i.folder_id, i.url, i.source_id, i.title, i.author, i.status, i.error, i.total, i.created_at,
      f.name AS folder_name,
      (SELECT COUNT(*) FROM media m WHERE m.import_id = i.id AND m.status = 'ready') AS done,
      (SELECT COUNT(*) FROM media m WHERE m.import_id = i.id AND m.status = 'error') AS failed
    FROM imports i JOIN folders f ON f.id = i.folder_id ${where} ORDER BY i.id DESC LIMIT 30`, ...p);
}

app.get('/api/imports', (req, res) => {
  // o que ainda está acontecendo ou deu erro nas últimas 48h
  res.json(importsList(`WHERE i.created_at > ? AND (i.status != 'parsed'
    OR EXISTS (SELECT 1 FROM media m WHERE m.import_id = i.id AND m.status IN ('queued','downloading','error')))`,
  new Date(Date.now() - 48 * 3600e3).toISOString()));
});

app.post('/api/imports', (req, res) => {
  const folder = getFolder(req.body?.folderId);
  if (!folder) return bad(res, 'Escolha uma pasta.');
  const found = albumUrlsFromText(req.body?.text);
  if (!found.length) return bad(res, 'Nenhum link de álbum reconhecido. Use links do tipo erome.com/a/XXXX.');
  let created = 0, existed = 0, retried = 0;
  for (const { id, url } of found) {
    const prev = one('SELECT * FROM imports WHERE folder_id = ? AND source_id = ? ORDER BY id DESC LIMIT 1', folder.id, id);
    if (prev && prev.status === 'error') { run("UPDATE imports SET status = 'queued', error = NULL WHERE id = ?", prev.id); retried++; continue; }
    if (prev) {
      const r = run("UPDATE media SET status = 'queued', error = NULL WHERE import_id = ? AND status = 'error' AND local_deleted = 0", prev.id);
      if (r.changes) retried++; else existed++;
      continue;
    }
    run("INSERT INTO imports (folder_id, url, source_id, status, created_at) VALUES (?, ?, ?, 'queued', ?)", folder.id, url, id, now());
    created++;
  }
  changedFolder(folder.id);
  queue.kick();
  res.status(201).json({ created, existed, retried });
});

app.post('/api/imports/:id/retry', (req, res) => {
  const imp = one('SELECT * FROM imports WHERE id = ?', req.params.id);
  if (!imp) return bad(res, 'Não encontrado', 404);
  if (imp.status === 'error') run("UPDATE imports SET status = 'queued', error = NULL WHERE id = ?", imp.id);
  run("UPDATE media SET status = 'queued', error = NULL WHERE import_id = ? AND status = 'error' AND local_deleted = 0 AND source_kind != 'edit'", imp.id);
  changedFolder(imp.folder_id); queue.kick();
  res.json({ ok: true });
});

app.delete('/api/imports/:id', (req, res) => {
  const imp = one('SELECT * FROM imports WHERE id = ?', req.params.id);
  if (imp && imp.status === 'error') run('DELETE FROM imports WHERE id = ?', imp.id);
  res.json({ ok: true });
});

// ---------- Ações em mídias (uma ou várias) ----------
app.post('/api/media/action', wrap(async (req, res) => {
  const list = ids(req.body?.ids);
  const action = req.body?.action;
  if (!list.length) return bad(res, 'Nada selecionado.');
  if (action === 'send') return res.json(queue.queueSend(list));
  if (action === 'free') return res.json(await queue.freeSpace(list));
  if (action === 'delete') {
    let n = 0;
    for (const id of list) { const m = getMedia(id); if (m) { queue.deleteMedia(m); n++; } }
    return res.json({ deleted: n });
  }
  if (action === 'retry') {
    const send = [];
    for (const id of list) {
      const m = getMedia(id);
      if (!m) continue;
      if (m.status === 'error') setMedia(id, { status: m.source_kind === 'edit' ? 'edit_queued' : 'queued', error: null });
      else if (m.bunny_status === 'error') { setMedia(id, { bunny_status: null, bunny_error: null }); send.push(id); }
      changedFolder(m.folder_id);
    }
    queue.kick();
    return res.json(send.length ? queue.queueSend(send) : { ok: true });
  }
  if (action === 'move') {
    const to = getFolder(req.body?.folderId);
    if (!to) return bad(res, 'Pasta de destino não encontrada.');
    for (const id of list) {
      const m = getMedia(id);
      if (!m || m.folder_id === to.id) continue;
      const base = m.name.replace(/\.[^.]+$/, '');
      run('UPDATE media SET folder_id = ?, name = ?, updated_at = ? WHERE id = ?', to.id, uniqueName(to.id, base, m.ext, m.id), now(), id);
      run('UPDATE imports SET folder_id = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM media WHERE import_id = ? AND folder_id != ?)',
        to.id, m.import_id, m.import_id, to.id);
      changedFolder(m.folder_id);
    }
    changedFolder(to.id);
    return res.json({ ok: true });
  }
  bad(res, 'Ação desconhecida');
}));

app.post('/api/media/:id/edit', (req, res) => {
  const p = getMedia(req.params.id);
  if (!p || p.status !== 'ready' || p.local_deleted) return bad(res, 'Essa mídia não está disponível para edição.');
  let spec;
  try { spec = cleanSpec(req.body?.spec, p.type); } catch (e) { return bad(res, e.message); }
  const { outType, ext } = buildEdit(spec, { type: p.type, ext: p.ext }, 'in', 'out');
  const r = run(`INSERT INTO media (folder_id, import_id, position, parent_id, type, source_kind, edit_spec, name, ext, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'edit', ?, ?, ?, 'edit_queued', ?, ?)`, p.folder_id, p.import_id, p.position, p.id, outType,
  JSON.stringify(spec), `tmp-${Date.now()}`, ext, now(), now());
  const id = Number(r.lastInsertRowid);
  const base = p.name.replace(/\.[^.]+$/, '').replace(/_ed\d+$/, '');
  setMedia(id, { name: uniqueName(p.folder_id, `${base}_ed${id}`, ext, id) });
  changedFolder(p.folder_id); queue.kick();
  res.status(201).json(mediaDto(getMedia(id)));
});

// .zip das selecionadas (form POST para o navegador baixar direto)
app.post('/api/zip', (req, res) => {
  const items = ids(req.body?.ids).map(getMedia).filter((m) => m && m.status === 'ready' && !m.local_deleted);
  if (!items.length) return res.status(400).send('Nenhum arquivo disponível no sistema.');
  const folder = getFolder(items[0].folder_id);
  res.attachment(`${folder.slug}.zip`);
  const zip = archiver('zip', { store: true }); // fotos e vídeos já são comprimidos
  zip.on('error', (e) => { console.error(e); res.destroy(e); });
  zip.pipe(res);
  for (const m of items) zip.file(queue.localPath(m), { name: `${folder.slug}/${m.name}` });
  zip.finalize();
});

// ---------- Arquivos ----------
app.get('/media/:id', (req, res) => {
  const m = getMedia(req.params.id);
  if (!m || m.status !== 'ready' || m.local_deleted) return res.status(404).end();
  if (req.query.dl) return res.download(queue.localPath(m), m.name);
  res.sendFile(queue.localPath(m), { maxAge: '7d' });
});

app.get('/thumb/:id', (req, res) => {
  const m = getMedia(req.params.id);
  const p = m && queue.thumbPath(m);
  if (!p || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p, { maxAge: '1d' });
});

// ---------- Atualização ao vivo (SSE) ----------
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('msg', send);
  req.on('close', () => { clearInterval(ping); bus.off('msg', send); });
});

// ---------- Compartilhar (Android) ----------
app.get('/share', (req, res) => {
  const url = extractUrl([req.query.url, req.query.text, req.query.title].join(' '));
  res.redirect('/' + (url ? `?add=${encodeURIComponent(url)}` : ''));
});

app.use(express.static(path.resolve('public'), { index: 'index.html', maxAge: 0 }));

app.use((err, req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Erro interno: ' + (err.message || err) });
});

migrateLegacy();
app.listen(PORT, () => {
  console.log(`Cofre rodando na porta ${PORT}${PIN ? '' : ' (SEM PIN — defina APP_PIN)'}`);
  console.log(`Limites: ${LIMITS.downloads} downloads, ${LIMITS.uploads} envios, ${LIMITS.ffmpeg} ffmpeg (${LIMITS.ffmpegThreads} threads) · Bunny Storage ${BUNNY.storage.enabled ? 'ok' : 'off'} · Stream ${BUNNY.stream.enabled ? 'ok' : 'off'}`);
  queue.boot();
});
