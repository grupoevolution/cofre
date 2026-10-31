import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { albumIdFromUrl, extractUrl, extractUrls, eromeProfileFromUrl } from './lib/erome.js';
import {
  DATA_DIR, ALBUMS_DIR, albumDir, readAlbum, writeAlbum, listAlbums, deleteAlbum, summary,
  allItems, findItem, publicItem, VISIBLE, unindexItem,
  listFolders, getFolder, createFolder, renameFolder, deleteFolder,
} from './lib/store.js';
import { enqueue, resumePending, isActive } from './lib/downloader.js';
import { bunnyEnabled, queueUpload, resumeUploads, bunnyBusy } from './lib/bunny.js';
import { engineVersions, startEngineUpdater } from './lib/engines.js';
import { listAccounts, saveCookies, deleteCookies } from './lib/cookies.js';
import { proxyMode } from './lib/net.js';
import { browserEnabled } from './lib/browser.js';

const PORT = Number(process.env.PORT || 3000);
const PIN = process.env.APP_PIN || '';
const SECRET = process.env.APP_SECRET || PIN;
const TOKEN = PIN ? crypto.createHmac('sha256', SECRET).update('ok:' + PIN).digest('hex') : null;

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ---------- PIN: sem PIN configurado, ninguém entra ----------
const cookieToken = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)es_auth=([a-f0-9]+)/)?.[1];
const authed = (req) => !!TOKEN && cookieToken(req) === TOKEN;

app.post('/api/login', (req, res) => {
  if (!PIN) return res.status(503).json({ error: 'Servidor sem PIN configurado (APP_PIN).' });
  const pin = String(req.body?.pin || '');
  const ok = pin.length === PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(PIN));
  if (ok) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `es_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    return res.json({ ok: true });
  }
  setTimeout(() => res.status(401).json({ error: 'PIN incorreto' }), 600);
});
app.get('/api/me', (req, res) => res.json({ authed: authed(req), configured: !!PIN }));

const requireAuth = (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'login necessário' }));
app.use('/api', (req, res, next) => (['/login', '/me'].includes(req.path) ? next() : requireAuth(req, res, next)));
app.use('/files', requireAuth);

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
};

// ---------- Painel: espaço em disco, motores, Bunny ----------
app.get('/api/stats', (req, res) => {
  let disk = null;
  try {
    const s = fs.statfsSync(DATA_DIR);
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { /* sistema sem statfs */ }
  let bytes = 0, files = 0, bunnyFiles = 0;
  for (const { item } of allItems()) {
    if (item.status !== 'done') continue;
    files++;
    if (item.local !== false) bytes += item.size || 0;
    if (item.bunny?.status === 'done') bunnyFiles++;
  }
  const busy = listAlbums().some((a) => ['queued', 'downloading'].includes(a.status)) || bunnyBusy();
  res.json({
    disk, bytes, files, bunnyFiles, busy, bunny: bunnyEnabled(), engines: engineVersions,
    proxy: proxyMode(), browser: browserEnabled(),
  });
});

// ---------- Contas (cookies de login por site) ----------
app.get('/api/accounts', (req, res) => res.json(listAccounts()));
app.post('/api/accounts', wrap((req, res) => {
  const sites = saveCookies(req.body?.text);
  // links que falharam por login/bloqueio nesses sites voltam para a fila sozinhos
  const retried = [];
  for (const a of listAlbums()) {
    if (a.status !== 'error' || !['login', 'blocked'].includes(a.errorCode)) continue;
    if (!sites.some((s) => (a.site || '').endsWith(s))) continue;
    a.status = 'queued';
    writeAlbum(a);
    enqueue(a.id);
    retried.push(a.id);
  }
  res.status(201).json({ sites, retried: retried.length, accounts: listAccounts() });
}));
app.delete('/api/accounts/:domain', (req, res) => { deleteCookies(req.params.domain); res.json(listAccounts()); });

// ---------- Fontes (cada link colado) ----------
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const genericId = (u) => 'g' + crypto.createHash('sha1').update(u).digest('hex').slice(0, 12);

function addSource(url, folderIds) {
  const eromeAlbum = albumIdFromUrl(url);
  const profile = !eromeAlbum && eromeProfileFromUrl(url);
  let id, base;
  if (eromeAlbum) {
    id = eromeAlbum;
    base = { url: `https://www.erome.com/a/${id}`, kind: 'erome', site: 'erome.com', author: '' };
  } else if (profile) {
    id = 'p-' + profile.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    base = { url: `https://www.erome.com/${profile}`, kind: 'erome-profile', site: 'erome.com', author: profile, title: `Perfil ${profile}` };
  } else {
    let u;
    try { u = new URL(url); } catch { return { url, invalid: true }; }
    if (!/^https?:$/.test(u.protocol)) return { url, invalid: true };
    u.hash = '';
    id = genericId(u.href);
    base = { url: u.href, kind: 'generic', site: hostOf(u.href), author: '' };
  }
  const existing = readAlbum(id);
  if (existing && existing.status !== 'error' && existing.kind !== 'erome-profile') {
    if (existing.status === 'partial') enqueue(id);
    if (folderIds.length) addFoldersToSource(existing, folderIds);
    return { ...summary(existing), existed: true };
  }
  const album = {
    id, title: '', ...base, items: existing?.items || [],
    createdAt: existing?.createdAt || new Date().toISOString(), status: 'queued',
    folderIds: [...new Set([...(existing?.folderIds || []), ...folderIds])],
  };
  writeAlbum(album);
  enqueue(id);
  return summary(album);
}

function addFoldersToSource(a, folderIds) {
  a.folderIds = [...new Set([...(a.folderIds || []), ...folderIds])];
  for (const it of a.items) if (VISIBLE(it)) it.folders = [...new Set([...(it.folders || []), ...folderIds])];
  writeAlbum(a);
}

app.get('/api/sources', (req, res) => res.json(listAlbums().map(summary)));

app.post('/api/sources', wrap((req, res) => {
  const raw = Array.isArray(req.body?.urls) ? req.body.urls.join('\n') : String(req.body?.urls ?? req.body?.url ?? '');
  const urls = extractUrls(raw);
  if (!urls.length) return res.status(400).json({ error: 'Nenhum link encontrado. Cole um ou mais links (um por linha).' });
  const folderIds = [].concat(req.body?.folderId || []).filter((id) => getFolder(id));
  const results = urls.slice(0, 200).map((u) => addSource(u, folderIds));
  res.status(201).json({
    added: results.filter((r) => !r.invalid && !r.existed).length,
    existed: results.filter((r) => r.existed).length,
    invalid: results.filter((r) => r.invalid).length,
    results,
  });
}));

app.get('/api/sources/:id', (req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'não encontrado' });
  res.json({ ...summary(a), items: a.items.filter(VISIBLE).map((it) => publicItem(a, it)) });
});

app.post('/api/sources/:id/retry', (req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'não encontrado' });
  if (isActive(a.id)) return res.json(summary(a));
  a.status = 'queued';
  a.items.forEach((i) => { if (['error', 'downloading', 'processing'].includes(i.status)) i.status = 'pending'; });
  writeAlbum(a);
  enqueue(a.id);
  res.json(summary(a));
});

app.post('/api/sources/:id/folders', wrap((req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'não encontrado' });
  addFoldersToSource(a, [].concat(req.body?.folderId || []).filter((id) => getFolder(id)));
  res.json(summary(a));
}));

app.delete('/api/sources/:id', (req, res) => {
  if (!readAlbum(req.params.id)) return res.status(404).json({ error: 'não encontrado' });
  if (isActive(req.params.id)) return res.status(409).json({ error: 'Ainda baixando — espere terminar para apagar.' });
  deleteAlbum(req.params.id);
  res.json({ ok: true });
});

// ---------- Biblioteca: todos os arquivos com filtros ----------
app.get('/api/items', (req, res) => {
  const q = req.query;
  const term = String(q.q || '').toLowerCase().trim();
  const folderNames = Object.fromEntries(listFolders().map((f) => [f.id, f.name.toLowerCase()]));
  const out = [];
  for (const { album, item } of allItems()) {
    if (!VISIBLE(item) || item.status !== 'done') continue;
    if (q.folder === 'none' ? item.folders?.length : q.folder && !item.folders?.includes(q.folder)) continue;
    if (q.source && album.id !== q.source) continue;
    if (q.type && item.type !== q.type) continue;
    const p = publicItem(album, item);
    if (q.orient && p.orient !== q.orient) continue;
    if (q.dur) {
      const d = item.duration || 0;
      if (item.type !== 'video') continue;
      if (q.dur === 'short' && d >= 30) continue;
      if (q.dur === 'mid' && (d < 30 || d > 120)) continue;
      if (q.dur === 'long' && d <= 120) continue;
    }
    if (q.hd === '1' && Math.min(item.width || 0, item.height || 0) < 720) continue;
    if (q.site && album.site !== q.site) continue;
    if (q.used === '1' && !item.used) continue;
    if (q.used === '0' && item.used) continue;
    if (q.bunny === '1' && item.bunny?.status !== 'done') continue;
    if (q.bunny === '0' && item.bunny?.status === 'done') continue;
    if (term) {
      const hay = [album.title, album.author, album.site, album.url, item.title, item.file,
        ...(item.folders || []).map((f) => folderNames[f])].join(' ').toLowerCase();
      if (!hay.includes(term)) continue;
    }
    out.push(p);
  }
  out.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '') || a.file.localeCompare(b.file));
  const sites = [...new Set(listAlbums().map((a) => a.site).filter(Boolean))].sort();
  res.json({ items: out, sites });
});

// Ações em lote: pasta, usado, Bunny, liberar espaço, apagar
app.post('/api/items/action', wrap((req, res) => {
  const { ids = [], action, folderId, bunnyFolder } = req.body || {};
  const found = [].concat(ids).map(findItem).filter(Boolean).filter(({ item }) => VISIBLE(item));
  if (!found.length) return res.status(400).json({ error: 'Nenhum arquivo selecionado.' });
  if (['addFolder', 'move', 'removeFolder'].includes(action) && !getFolder(folderId)) throw new Error('Pasta não encontrada.');
  const touched = new Set();
  let n = 0;
  if (action === 'bunny') {
    n = queueUpload(found.map(({ album, item }) => `${album.id}/${item.file}`), bunnyFolder);
    return res.json({ ok: true, count: n });
  }
  for (const { album, item } of found) {
    const dir = albumDir(album.id);
    switch (action) {
      case 'addFolder': item.folders = [...new Set([...(item.folders || []), folderId])]; break;
      case 'move': item.folders = [folderId]; break;
      case 'removeFolder': item.folders = (item.folders || []).filter((f) => f !== folderId); break;
      case 'used': item.used = true; break;
      case 'unused': item.used = false; break;
      case 'freeLocal':
        if (item.bunny?.status !== 'done' || item.local === false) continue;
        fs.rmSync(path.join(dir, item.file), { force: true });
        item.local = false;
        break;
      case 'delete':
        if (['queued', 'uploading'].includes(item.bunny?.status)) continue;
        fs.rmSync(path.join(dir, item.file), { force: true });
        if (item.thumb) fs.rmSync(path.join(dir, item.thumb), { force: true });
        unindexItem(album, item);
        item.status = 'deleted'; // fica marcado para não ser baixado de novo no "Tentar de novo"
        break;
      default: throw new Error('Ação desconhecida.');
    }
    n++;
    touched.add(album);
  }
  for (const a of touched) writeAlbum(a);
  res.json({ ok: true, count: n });
}));

// ---------- Pastas ----------
function folderCounts() {
  const c = {};
  let none = 0;
  for (const { item } of allItems()) {
    if (!VISIBLE(item) || item.status !== 'done') continue;
    if (!item.folders?.length) none++;
    for (const f of item.folders || []) c[f] = (c[f] || 0) + 1;
  }
  return { c, none };
}
app.get('/api/folders', (req, res) => {
  const { c, none } = folderCounts();
  res.json({ folders: listFolders().map((f) => ({ ...f, count: c[f.id] || 0 })), none });
});
app.post('/api/folders', wrap((req, res) => res.status(201).json(createFolder(req.body?.name))));
app.patch('/api/folders/:id', wrap((req, res) => {
  const f = renameFolder(req.params.id, req.body?.name);
  if (!f) return res.status(404).json({ error: 'não encontrada' });
  res.json(f);
}));
app.delete('/api/folders/:id', (req, res) => { deleteFolder(req.params.id); res.json({ ok: true }); });

// ---------- Download para o PC (.zip) ----------
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
const folderName = (a) => [slug(a.author), slug(a.title), a.id].filter(Boolean).join('_');

function sendZip(res, name, entries) {
  res.attachment(`${name}.zip`);
  const zip = archiver('zip', { store: true }); // vídeo e foto já são comprimidos
  zip.on('error', (e) => { console.error(e); res.destroy(e); });
  zip.pipe(res);
  for (const { album, item, as } of entries) {
    const file = path.join(albumDir(album.id), item.file);
    if (item.local !== false && fs.existsSync(file)) zip.file(file, { name: `${name}/${as}` });
  }
  zip.finalize();
}
const localDone = (it) => VISIBLE(it) && it.status === 'done' && it.local !== false;

app.get('/api/sources/:id/zip', (req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).end();
  sendZip(res, folderName(a), a.items.filter(localDone).map((item) => ({ album: a, item, as: item.file })));
});

app.get('/api/folders/:id/zip', (req, res) => {
  const f = getFolder(req.params.id);
  if (!f) return res.status(404).end();
  const entries = [];
  for (const { album, item } of allItems()) {
    if (localDone(item) && item.folders?.includes(f.id)) entries.push({ album, item, as: `${album.id}-${item.file}` });
  }
  sendZip(res, slug(f.name) || 'pasta', entries);
});

// Seleção: o navegador envia um formulário com os ids (lista pode ser grande demais para a URL)
app.post('/api/zip', (req, res) => {
  let ids = [];
  try { ids = JSON.parse(req.body?.ids || '[]'); } catch { /* vazio */ }
  const entries = ids.map(findItem).filter(Boolean).filter(({ item }) => localDone(item))
    .map(({ album, item }) => ({ album, item, as: `${album.id}-${item.file}` }));
  const name = slug(req.body?.name) || `cofre-${new Date().toISOString().slice(0, 10)}`;
  sendZip(res, name, entries);
});

// Arquivo único (com suporte a Range para o player de vídeo). ?dl=1 força download.
app.use('/files', (req, res, next) => {
  if (req.query.dl) {
    const [id, file] = req.path.split('/').filter(Boolean);
    const a = readAlbum(id);
    if (a && file) res.attachment(`${folderName(a)}_${decodeURIComponent(file)}`);
  }
  next();
}, express.static(ALBUMS_DIR, { index: false, dotfiles: 'deny', maxAge: '7d' }));

// ---------- Compartilhar (Android) ----------
app.get('/share', (req, res) => {
  const url = extractUrl([req.query.url, req.query.text, req.query.title].join(' '));
  res.redirect('/' + (url ? `?add=${encodeURIComponent(url)}` : ''));
});

app.use(express.static(path.resolve('public'), { index: 'index.html' }));

app.listen(PORT, () => {
  console.log(`Cofre rodando na porta ${PORT}${PIN ? '' : ' — BLOQUEADO: defina APP_PIN para usar'}`);
  resumePending();
  resumeUploads(allItems);
  startEngineUpdater();
});
