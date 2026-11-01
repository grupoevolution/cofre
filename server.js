import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { albumIdFromUrl, extractUrl } from './lib/erome.js';
import { ALBUMS_DIR, albumDir, readAlbum, writeAlbum, listAlbums, deleteAlbum, summary } from './lib/store.js';
import { enqueue, resumePending } from './lib/downloader.js';

const PORT = Number(process.env.PORT || 3000);
const PIN = process.env.APP_PIN || '';
const SECRET = process.env.APP_SECRET || PIN || 'dev';
const TOKEN = crypto.createHmac('sha256', SECRET).update('ok:' + PIN).digest('hex');

const app = express();
app.set('trust proxy', true);
app.use(express.json());

// ---------- Autenticação por PIN ----------
const cookieToken = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)es_auth=([a-f0-9]+)/)?.[1];
const authed = (req) => !PIN || cookieToken(req) === TOKEN;

app.post('/api/login', (req, res) => {
  const pin = String(req.body?.pin || '');
  const ok = PIN && pin.length === PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(PIN));
  if (!PIN || ok) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `es_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    return res.json({ ok: true });
  }
  setTimeout(() => res.status(401).json({ error: 'PIN incorreto' }), 600);
});
app.get('/api/me', (req, res) => res.json({ authed: authed(req) }));

const requireAuth = (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'login necessário' }));
app.use('/api/albums', requireAuth);
app.use('/files', requireAuth);

// ---------- Álbuns ----------
app.get('/api/albums', (req, res) => res.json(listAlbums().map(summary)));

app.post('/api/albums', (req, res) => {
  const url = extractUrl(req.body?.url) || String(req.body?.url || '').trim();
  const id = albumIdFromUrl(url);
  if (!id) return res.status(400).json({ error: 'Link não reconhecido. Use um link de álbum do erome (…erome.com/a/XXXX).' });

  const existing = readAlbum(id);
  if (existing && existing.status !== 'error') {
    if (existing.status === 'partial') enqueue(id);
    return res.json({ ...summary(existing), existed: true });
  }
  const album = {
    id, url: `https://www.erome.com/a/${id}`, title: '', author: '',
    createdAt: existing?.createdAt || new Date().toISOString(), status: 'queued', items: [],
  };
  writeAlbum(album);
  enqueue(id);
  res.status(201).json(summary(album));
});

app.get('/api/albums/:id', (req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'não encontrado' });
  res.json({ ...summary(a), items: a.items.map(({ url, ...rest }) => rest) });
});

app.post('/api/albums/:id/retry', (req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'não encontrado' });
  a.status = 'queued';
  a.items.forEach((i) => { if (i.status !== 'done') i.status = 'pending'; });
  writeAlbum(a);
  enqueue(a.id);
  res.json(summary(a));
});

app.delete('/api/albums/:id', (req, res) => {
  if (!readAlbum(req.params.id)) return res.status(404).json({ error: 'não encontrado' });
  deleteAlbum(req.params.id);
  res.json({ ok: true });
});

const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
const folderName = (a) => [slug(a.author), slug(a.title), a.id].filter(Boolean).join('_');

app.get('/api/albums/:id/zip', (req, res) => {
  const a = readAlbum(req.params.id);
  if (!a) return res.status(404).end();
  const name = folderName(a);
  res.attachment(`${name}.zip`);
  const zip = archiver('zip', { store: true }); // vídeos já são comprimidos
  zip.on('error', (e) => { console.error(e); res.destroy(e); });
  zip.pipe(res);
  for (const it of a.items.filter((i) => i.status === 'done')) {
    zip.file(path.join(albumDir(a.id), it.file), { name: `${name}/${it.file}` });
  }
  zip.finalize();
});

// Arquivos (com suporte a Range para o player de vídeo). ?dl=1 força download.
app.use('/files', (req, res, next) => {
  if (req.query.dl) {
    const [id, file] = req.path.split('/').filter(Boolean);
    const a = readAlbum(id);
    if (a && file) res.attachment(`${folderName(a)}_${file}`);
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
  console.log(`erome-saver rodando na porta ${PORT}${PIN ? '' : ' (SEM PIN — defina APP_PIN)'}`);
  resumePending();
});
