import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fetchAlbumPage, parseAlbum, mediaHeaders, MOBILE_UA, REFERER, listProfileAlbums } from './erome.js';
import { readAlbum, writeAlbum, albumDir, listAlbums, hashIndex, itemKey, findItem } from './store.js';
import { run, probe, makeThumb, hashFile, stripMetadata, typeOf, extOf } from './media.js';
import { downloadHttp, isDirectMedia, ytdlp, gallerydl } from './engines.js';

const FILE_CONCURRENCY = Number(process.env.FILE_CONCURRENCY || 3);
const ALBUM_CONCURRENCY = Number(process.env.ALBUM_CONCURRENCY || 2);
const queue = [];
const active = new Set();

export const isActive = (id) => active.has(id) || queue.includes(id);

export function enqueue(id) {
  if (!isActive(id)) queue.push(id);
  pump();
}

function pump() {
  while (active.size < ALBUM_CONCURRENCY && queue.length) {
    const id = queue.shift();
    active.add(id);
    processAlbum(id)
      .catch((e) => console.error('[fonte]', id, e))
      .finally(() => { active.delete(id); pump(); });
  }
}

// Ao reiniciar o servidor, retoma o que ficou pela metade.
export function resumePending() {
  for (const a of listAlbums()) {
    let changed = false;
    for (const it of a.items) if (it.status === 'processing') { it.status = 'pending'; changed = true; }
    if (changed) writeAlbum(a);
    if (['queued', 'downloading'].includes(a.status)) enqueue(a.id);
  }
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}

/**
 * Depois que um arquivo chega: impressão digital (anti-duplicado), medidas,
 * limpeza de dados escondidos e miniatura. Se já existir igual na biblioteca, descarta.
 */
async function finalize(album, it) {
  const dest = path.join(albumDir(album.id), it.file);
  const hash = await hashFile(dest);
  const key = itemKey(album, it);
  const prev = hashIndex.get(hash);
  if (prev && prev !== key && findItem(prev)?.item.status === 'done') {
    fs.rmSync(dest, { force: true });
    Object.assign(it, { status: 'duplicate', dupOf: prev, hash, error: null });
    return;
  }
  hashIndex.set(hash, key); // reserva já, antes de outro arquivo igual terminar em paralelo
  it.hash = hash;
  const info = await probe(dest);
  await stripMetadata(dest, it.type, info);
  it.size = fs.statSync(dest).size;
  if (info.width) { it.width = info.width; it.height = info.height; }
  if (it.type === 'video') {
    it.duration = info.duration;
    const thumb = it.file.replace(/\.[^.]+$/, '.thumb.jpg');
    if (await makeThumb(dest, path.join(albumDir(album.id), thumb), info.duration)) it.thumb = thumb;
  }
  it.folders ||= [...(album.folderIds || [])];
  Object.assign(it, { status: 'done', local: true, error: null, addedAt: new Date().toISOString() });
}

function closeAlbum(album, extraError) {
  const vis = album.items.filter((i) => i.status !== 'deleted');
  const failed = vis.filter((i) => i.status === 'error').length;
  const ok = vis.filter((i) => i.status === 'done' || i.status === 'duplicate').length;
  const dups = vis.filter((i) => i.status === 'duplicate').length;
  album.progress = null;
  album.finishedAt = new Date().toISOString();
  if (!ok && !failed) {
    album.status = 'error';
    album.error = extraError || 'Nenhum vídeo ou foto encontrado nesse link.';
  } else {
    album.status = failed === 0 ? 'done' : ok === 0 ? 'error' : 'partial';
    album.error = failed ? `${failed} arquivo(s) falharam — toque em "Tentar de novo".` : null;
  }
  album.note = dups ? `${dups} repetido(s) ignorado(s) — já estavam na biblioteca` : album.note || null;
}

async function processAlbum(id) {
  const album = readAlbum(id);
  if (!album) return;
  const save = () => writeAlbum(album);
  album.status = 'downloading';
  album.error = null;
  save();
  try {
    if (album.kind === 'erome-profile') return await processProfile(album, save);
    if (album.kind === 'generic') return await processGeneric(album, save);
    return await processErome(album, save);
  } catch (e) {
    album.status = 'error';
    album.progress = null;
    album.error = String(e.message || e);
    save();
  }
}

// ---------- Perfil do erome: vira um álbum por post, todos na mesma pasta ----------
async function processProfile(album, save) {
  const user = album.author;
  const ids = await withRetry(() => listProfileAlbums(user));
  let added = 0;
  for (const aid of ids) {
    if (readAlbum(aid)) continue;
    writeAlbum({
      id: aid, url: `https://www.erome.com/a/${aid}`, kind: 'erome', site: 'erome.com', title: '', author: user,
      createdAt: new Date().toISOString(), status: 'queued', items: [], folderIds: [...(album.folderIds || [])], parent: album.id,
    });
    enqueue(aid);
    added++;
  }
  album.status = ids.length ? 'done' : 'error';
  album.error = ids.length ? null : 'Nenhum álbum encontrado nesse perfil.';
  album.note = `${ids.length} álbuns no perfil · ${added} novos na fila`;
  album.finishedAt = new Date().toISOString();
  save();
}

// ---------- Álbum do erome (leitor próprio, o mais rápido para esse site) ----------
async function downloadHls(url, dest) {
  const tmp = dest + '.part.mp4';
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats_period', '5', '-progress', 'pipe:2',
      '-rw_timeout', '30000000', '-user_agent', MOBILE_UA, '-headers', `Referer: ${REFERER}\r\n`,
      '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', tmp], { idleMs: 120e3, totalMs: 3 * 3600e3 });
    fs.renameSync(tmp, dest);
  } finally { fs.rmSync(tmp, { force: true }); }
}

const extFrom = (url, type) => {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  if (m && type !== 'hls') return m[1].toLowerCase();
  return type === 'image' ? 'jpg' : 'mp4';
};

async function processErome(album, save) {
  if (!album.items.length) {
    const html = await withRetry(() => fetchAlbumPage(album.url));
    const parsed = parseAlbum(html, album.url);
    if (!parsed.items.length) throw new Error('Nenhum vídeo ou imagem encontrado nessa página (álbum privado, removido ou layout mudou).');
    album.title = parsed.title || album.title;
    album.author = parsed.author || album.author;
    if (!album.title) album.title = [album.author, album.id].filter(Boolean).join(' · ');
    const pad = Math.max(3, String(parsed.items.length).length);
    album.items = parsed.items.map((it, i) => ({
      url: it.url, type: it.type === 'image' ? 'image' : 'video', hls: it.type === 'hls',
      file: `${String(i + 1).padStart(pad, '0')}.${extFrom(it.url, it.type)}`,
      status: 'pending',
    }));
    save();
  }
  const dir = albumDir(album.id);
  const pending = album.items.filter((i) => ['pending', 'error', 'downloading', 'processing'].includes(i.status));
  let idx = 0;
  const worker = async () => {
    while (idx < pending.length) {
      const it = pending[idx++];
      it.status = 'downloading'; save();
      const dest = path.join(dir, it.file);
      try {
        await withRetry(() => (it.hls || it.type === 'hls' ? downloadHls(it.url, dest) : downloadHttp(it.url, dest, mediaHeaders())));
        it.status = 'processing'; save();
        await finalize(album, it);
      } catch (e) {
        it.status = 'error';
        it.error = String(e.message || e);
      }
      album.progress = `${album.items.filter((i) => i.status === 'done').length}/${album.items.length}`;
      save();
    }
  };
  await Promise.all(Array.from({ length: FILE_CONCURRENCY }, worker));
  closeAlbum(album);
  save();
}

// ---------- Qualquer outro site ----------
async function processGeneric(album, save) {
  const dir = albumDir(album.id);
  fs.mkdirSync(dir, { recursive: true });
  const known = new Set(album.items.map((i) => i.file));
  const jobs = [];
  let lastSave = 0;
  const progress = (p) => {
    album.progress = `${album.items.filter((i) => i.status === 'done').length} prontos${p ? ' · baixando ' + p : ''}`;
    if (Date.now() - lastSave > 2000) { lastSave = Date.now(); save(); }
  };

  const onFile = (file, meta = {}) => {
    const name = path.basename(file);
    if (path.resolve(path.dirname(file)) !== path.resolve(dir) || known.has(name)) return;
    const type = typeOf(name);
    if (!type) return;
    known.add(name);
    if (!album.title && (meta.playlist || meta.title)) album.title = meta.playlist || meta.title;
    if (!album.author && meta.uploader) album.author = meta.uploader;
    const it = { file: name, type, status: 'processing', title: meta.title || '' };
    album.items.push(it);
    save();
    jobs.push(finalize(album, it)
      .catch((e) => { it.status = 'error'; it.error = String(e.message || e); })
      .then(() => { progress(); save(); }));
  };

  const errors = [];
  if (isDirectMedia(album.url)) {
    // Link direto para o arquivo
    const ext = extOf(new URL(album.url).pathname);
    const name = path.basename(new URL(album.url).pathname).replace(/[^\w.-]/g, '_').slice(-80) || `001.${ext}`;
    try {
      await withRetry(() => downloadHttp(album.url, path.join(dir, name), { Referer: new URL(album.url).origin + '/' }));
      onFile(path.join(dir, name));
    } catch (e) { errors.push(String(e.message || e)); }
  } else {
    // 1º yt-dlp (vídeo) → 2º gallery-dl (fotos/álbuns) → 3º leitura da página
    const yt = await ytdlp(album.url, dir, { onFile, onProgress: progress });
    if (!yt.ok) errors.push(`yt-dlp: ${yt.error}`);
    if (!known.size) {
      const gd = await gallerydl(album.url, dir, { onFile });
      if (!gd.ok) errors.push(`gallery-dl: ${gd.error}`);
    }
    if (!known.size) {
      try { await scrapePage(album, dir, onFile); } catch (e) { errors.push(`página: ${e.message}`); }
    }
  }
  await Promise.all(jobs);
  if (!album.title) {
    const u = new URL(album.url);
    album.title = (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').slice(0, 120);
  }
  closeAlbum(album, errors.length ? errors.join(' · ') : null);
  save();
}

/** Último recurso: lê a página e pega vídeos (<video>, og:video) e links diretos para arquivos. */
async function scrapePage(album, dir, onFile) {
  const res = await fetch(album.url, {
    headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(45e3),
  });
  if (!res.ok) throw new Error(`o site respondeu ${res.status}`);
  const $ = cheerio.load(await res.text());
  if (!album.title) album.title = $('meta[property="og:title"]').attr('content')?.trim() || $('title').text().trim().slice(0, 150);
  const urls = new Set();
  const add = (s) => { try { if (s && !s.startsWith('data:') && !s.startsWith('blob:')) urls.add(new URL(s.trim(), album.url).href); } catch { /* ignora */ } };
  $('video[src], video source[src]').each((_, el) => add($(el).attr('src')));
  $('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').each((_, el) => add($(el).attr('content')));
  $('a[href]').each((_, el) => {
    try { const h = new URL($(el).attr('href'), album.url).href; if (isDirectMedia(h)) add(h); } catch { /* link inválido */ }
  });
  if (![...urls].some((u) => typeOf(new URL(u).pathname) === 'video')) add($('meta[property="og:image"]').attr('content'));
  const list = [...urls].filter((u) => isDirectMedia(u)).slice(0, 300);
  if (!list.length) throw new Error('nenhum arquivo de mídia na página');
  let n = 0;
  for (const u of list) {
    const ext = extOf(new URL(u).pathname);
    const name = `${String(++n).padStart(3, '0')}.${ext}`;
    try {
      await withRetry(() => downloadHttp(u, path.join(dir, name), { Referer: album.url }), 2);
      onFile(path.join(dir, name));
    } catch { /* um arquivo ruim não derruba os outros */ }
  }
}
