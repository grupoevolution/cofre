import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fetchAlbumPage, parseAlbum, mediaHeaders, MOBILE_UA, REFERER, listProfileAlbums } from './erome.js';
import { readAlbum, writeAlbum, albumDir, listAlbums, hashIndex, visualIndex, itemKey, findItem } from './store.js';
import { run, probe, makeThumb, makeSprite, visualHash, hamming, hashFile, stripMetadata, typeOf, extOf } from './media.js';
import { Meter, setLive, clearLive, logEvent } from './activity.js';
import { bunnyEnabled, queueUpload } from './bunny.js';
import { tagsEnabled, queueTagging, tagNow } from './tags.js';
import { hlsProgress, downloadHttp, downloadHls as downloadHlsGeneric, isDirectMedia, ytdlp, gallerydl, engineBlocked, httpBlocked } from './engines.js';
import { withProxyFallback, proxyMode, netFetch, isBlockStatus } from './net.js';
import { classify, pickError } from './errors.js';
import { browserEnabled, grabMedia } from './browser.js';
import { cookieHeader } from './cookies.js';

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
    try { return await fn(); } catch (e) {
      last = e;
      if (isBlockStatus(e.status) || e.status === 404 || e.status === 401) break; // repetir não adianta
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Depois que um arquivo chega: impressão digital (anti-duplicado), medidas,
 * limpeza de dados escondidos e miniatura. Se já existir igual na biblioteca, descarta.
 */
export async function finalize(album, it) {
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
    // vídeo a partir de 20 s ganha prévia (passar o dedo na miniatura mostra o vídeo inteiro)
    if (info.duration >= 20) {
      const sprite = it.file.replace(/\.[^.]+$/, '.sprite.jpg');
      if (await makeSprite(dest, path.join(albumDir(album.id), sprite), info.duration)) it.sprite = sprite;
    }
  }
  await markSimilar(album, it, dest);
  it.folders ||= [...(album.folderIds || [])];
  Object.assign(it, { status: 'done', local: true, error: null, addedAt: new Date().toISOString() });
  afterDone(album, it);
}

/** Quase-duplicado: compara a impressão visual com tudo da biblioteca e marca o parecido (não apaga). */
export async function markSimilar(album, it, file) {
  try {
    it.phash = await visualHash(file || path.join(albumDir(album.id), it.file), it.type, it.duration);
  } catch { return; }
  const key = itemKey(album, it);
  const limit = it.type === 'video' ? 6 : 8;
  let best = null;
  for (const [k, v] of visualIndex) {
    if (k === key || v.type !== it.type) continue;
    const d = hamming(it.phash, v.hash);
    if (d <= limit && (!best || d < best.d)) best = { k, d };
  }
  it.similarTo = best ? best.k : null;
  visualIndex.set(key, { hash: it.phash, type: it.type });
}

/**
 * Depois de pronto: se o download foi marcado "direto pro Bunny", analisa as legendas
 * (precisa do arquivo), envia e apaga do servidor. Se não, só entra na fila de legendas.
 */
function afterDone(album, it) {
  const key = itemKey(album, it);
  if (album.autoBunny?.dir && bunnyEnabled()) {
    (tagsEnabled() ? tagNow(key).catch(() => {}) : Promise.resolve())
      .then(() => queueUpload([key], album.autoBunny.dir, { autoFree: album.autoBunny.free !== false }))
      .catch((e) => logEvent(album, `Bunny: ${e.message}`));
  } else queueTagging(key);
}

/** Diagnóstico mostrado no app: o que houve (error) + o que fazer (hint) + detalhe técnico. */
function setDiag(album, d) {
  album.error = d?.msg || null;
  album.hint = d?.hint || null;
  album.errorCode = d?.code || null;
  album.errorDetail = d?.detail ? String(d.detail).slice(0, 500) : null;
}

function closeAlbum(album, diag) {
  const vis = album.items.filter((i) => i.status !== 'deleted');
  const failed = vis.filter((i) => i.status === 'error');
  const ok = vis.filter((i) => i.status === 'done' || i.status === 'duplicate').length;
  const dups = vis.filter((i) => i.status === 'duplicate').length;
  album.progress = null;
  album.finishedAt = new Date().toISOString();
  if (!ok && !failed.length) {
    album.status = 'error';
    setDiag(album, diag || classify('nenhum vídeo', album.site));
  } else {
    album.status = failed.length === 0 ? 'done' : ok === 0 ? 'error' : 'partial';
    if (!failed.length) setDiag(album, null);
    else {
      const d = pickError(failed.map((i) => ({ text: i.error })), album.site);
      setDiag(album, { ...d, msg: `${failed.length} arquivo(s) falharam: ${d.msg.charAt(0).toLowerCase()}${d.msg.slice(1)}` });
    }
  }
  album.note = dups ? `${dups} repetido(s) ignorado(s) — já estavam na biblioteca` : album.note || null;
}

// ---------- Progresso ao vivo (painel Atividade) ----------
const trackers = new Map();
function tracker(album) {
  const t = {
    stage(stage, extra = {}) {
      setLive(album.id, { stage, pct: null, bytes: null, total: null, speed: null, eta: null, seconds: null, ...extra });
      if (t.lastStage !== stage) { t.lastStage = stage; logEvent(album, stage); }
    },
    /** onProgress para downloadHttp: % / velocidade / tempo restante */
    http(file) {
      const m = new Meter();
      if (file) setLive(album.id, { file });
      return (got, total) => {
        m.set(got, total);
        setLive(album.id, { pct: m.pct, bytes: m.bytes, total: m.total || null, speed: Math.round(m.speed), eta: m.eta });
      };
    },
    hls(p) { setLive(album.id, { bytes: p.bytes, seconds: p.seconds }); },
  };
  trackers.set(album.id, t);
  return t;
}

async function processAlbum(id) {
  const album = readAlbum(id);
  if (!album) return;
  const save = () => writeAlbum(album);
  album.status = 'downloading';
  album.startedAt = new Date().toISOString();
  setDiag(album, null);
  setLive(album.id, { startedAt: album.startedAt });
  tracker(album).stage('Começando');
  save();
  try {
    if (album.kind === 'erome-profile') return await processProfile(album, save);
    if (album.kind === 'generic') return await processGeneric(album, save);
    return await processErome(album, save);
  } catch (e) {
    album.status = 'error';
    album.progress = null;
    setDiag(album, { ...classify(e.message, album.site), detail: String(e.message || e) });
    save();
  } finally {
    const done = album.items.filter((i) => i.status === 'done').length;
    logEvent(album, album.status === 'error'
      ? `✖ Falhou: ${album.error || ''}`
      : `✔ Terminou: ${done} arquivo(s)${album.status === 'partial' ? ' (alguns falharam)' : ''}`);
    writeAlbum(album);
    clearLive(album.id);
    trackers.delete(album.id);
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
      ...(album.autoBunny ? { autoBunny: { ...album.autoBunny } } : {}),
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
async function downloadHls(url, dest, onProgress) {
  const tmp = dest + '.part.mp4';
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats_period', '2', '-progress', 'pipe:2',
      '-rw_timeout', '30000000', '-user_agent', MOBILE_UA, '-headers', `Referer: ${REFERER}\r\n`,
      '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', tmp], { idleMs: 120e3, totalMs: 4 * 3600e3, onLine: hlsProgress(onProgress) });
    fs.renameSync(tmp, dest);
  } finally { fs.rmSync(tmp, { force: true }); }
}

const extFrom = (url, type) => {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  if (m && type !== 'hls') return m[1].toLowerCase();
  return type === 'image' ? 'jpg' : 'mp4';
};

async function processErome(album, save) {
  const tr = trackers.get(album.id);
  if (!album.items.length) {
    tr.stage('Lendo o álbum');
    const html = await withProxyFallback((proxy) => withRetry(() => fetchAlbumPage(album.url, proxy)), httpBlocked);
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
  // vários arquivos ao mesmo tempo: soma os bytes de todos para a velocidade total
  const meter = new Meter();
  const progressOf = () => {
    const done = album.items.filter((i) => i.status === 'done').length;
    setLive(album.id, {
      stage: 'Baixando', file: `arquivo ${Math.min(done + 1, album.items.length)} de ${album.items.length}`,
      pct: Math.round((done / album.items.length) * 100), bytes: meter.bytes, total: null, speed: Math.round(meter.speed), eta: null,
    });
  };
  tr.stage('Baixando');
  const worker = async () => {
    while (idx < pending.length) {
      const it = pending[idx++];
      it.status = 'downloading'; save();
      const dest = path.join(dir, it.file);
      let last = 0;
      const onBytes = (got) => { meter.add(Math.max(0, got - last)); last = got; progressOf(); };
      try {
        await withProxyFallback((proxy) => withRetry(() => (it.hls || it.type === 'hls'
          ? downloadHls(it.url, dest, (p) => onBytes(p.bytes))
          : downloadHttp(it.url, dest, mediaHeaders(), { proxy, onProgress: onBytes }))), httpBlocked);
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
// Ordem: link direto → yt-dlp → gallery-dl → leitura da página → navegador invisível.
// Cada etapa tenta direto e, se o site bloquear o servidor, de novo pelo proxy (se houver).
async function processGeneric(album, save) {
  const dir = albumDir(album.id);
  fs.mkdirSync(dir, { recursive: true });
  const known = new Set(album.items.map((i) => i.file));
  const jobs = [];
  let lastSave = 0;
  const progress = (p) => {
    album.progress = `${album.items.filter((i) => i.status === 'done').length} prontos${p ? ' · ' + p : ''}`;
    if (Date.now() - lastSave > 2000) { lastSave = Date.now(); save(); }
  };

  const tr = trackers.get(album.id);
  const onYtProgress = (p) => {
    if (p.stage) tr.stage(p.stage, p.file ? { file: p.file } : {});
    else if (p.file) setLive(album.id, { file: p.file });
    if (p.pct != null) {
      setLive(album.id, { pct: p.pct, bytes: p.bytes, total: p.total, speed: p.speed, eta: p.eta });
      progress(`baixando ${p.pct}%`);
    }
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
  const mode = proxyMode();
  const engineStep = async (name, fn) => {
    tr.stage(`Tentando com ${name}`);
    const r = await fn(mode === 'always');
    if (r.ok) return;
    if (!known.size && mode === 'fallback' && engineBlocked(r)) {
      progress('o site bloqueou, tentando pelo proxy…');
      tr.stage(`O site bloqueou — tentando ${name} pelo proxy`);
      const r2 = await fn(true);
      if (!r2.ok) errors.push({ text: `${name} (proxy): ${r2.error}`, viaProxy: true });
      return;
    }
    errors.push({ text: `${name}: ${r.error}` });
  };
  const step = async (label, fn) => {
    tr.stage(label === 'página' ? 'Lendo a página' : label === 'navegador' ? 'Abrindo no navegador invisível' : 'Baixando o link direto');
    try { await withProxyFallback(fn, httpBlocked); } catch (e) { errors.push({ text: `${label}: ${e.message || e}`, viaProxy: e.viaProxy }); }
  };

  if (isDirectMedia(album.url)) {
    const ext = extOf(new URL(album.url).pathname);
    const name = path.basename(new URL(album.url).pathname).replace(/[^\w.-]/g, '_').slice(-80) || `001.${ext}`;
    const dest = path.join(dir, name);
    await step('link direto', async (proxy) => {
      if (proxy) tr.stage('O site bloqueou — baixando pelo proxy');
      await withRetry(() => downloadHttp(album.url, dest, { Referer: new URL(album.url).origin + '/' }, { proxy, onProgress: tr.http(name) }));
      onFile(dest);
    });
  } else {
    await engineStep('yt-dlp', (proxy) => ytdlp(album.url, dir, { onFile, onProgress: onYtProgress, proxy }));
    if (!known.size) await engineStep('gallery-dl', (proxy) => gallerydl(album.url, dir, { onFile, proxy }));
    if (!known.size) await step('página', (proxy) => scrapePage(album, dir, onFile, proxy));
    if (!known.size && browserEnabled()) {
      progress('abrindo a página no navegador…');
      save();
      await step('navegador', (proxy) => browserStep(album, dir, onFile, proxy));
    }
  }
  await Promise.all(jobs);
  if (!album.title) {
    const u = new URL(album.url);
    album.title = (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').slice(0, 120);
  }
  closeAlbum(album, errors.length ? pickError(errors, album.site) : null);
  save();
}

/** Lê o HTML e pega vídeos (<video>, og:video) e links diretos para arquivos. */
async function scrapePage(album, dir, onFile, proxy) {
  const cookie = cookieHeader(album.url);
  const res = await netFetch(album.url, {
    headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,*/*', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow', signal: AbortSignal.timeout(45e3),
  }, { proxy });
  if (!res.ok) throw Object.assign(new Error(`o site respondeu ${res.status}`), { status: res.status });
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
    const name = `${String(++n).padStart(3, '0')}.${extOf(new URL(u).pathname)}`;
    try {
      await withRetry(() => downloadHttp(u, path.join(dir, name), { Referer: album.url }, { proxy, onProgress: trackers.get(album.id)?.http(name) }), 2);
      onFile(path.join(dir, name));
    } catch { /* um arquivo ruim não derruba os outros */ }
  }
}

/** Último recurso: navegador invisível dá play e pega o vídeo que a página carrega. */
async function browserStep(album, dir, onFile, proxy) {
  const { title, media, status } = await grabMedia(album.url, { proxy });
  if (!album.title && title) album.title = title;
  if (!media.length) {
    throw Object.assign(new Error(`nenhum vídeo apareceu na página${status >= 400 ? ` (o site respondeu ${status})` : ''}`), { status });
  }
  let n = 0;
  let got = 0;
  let lastErr = null;
  for (const m of media) {
    const ext = m.type === 'hls' ? 'mp4' : extOf(new URL(m.url).pathname) || 'mp4';
    const dest = path.join(dir, `nav-${String(++n).padStart(3, '0')}.${ext}`);
    try {
      const tr = trackers.get(album.id);
      tr?.stage('Baixando o vídeo que a página tocou', { file: path.basename(dest) });
      if (m.type === 'hls') await downloadHlsGeneric(m.url, dest, { referer: album.url, proxy, onProgress: (p) => tr?.hls(p) });
      else await withRetry(() => downloadHttp(m.url, dest, { Referer: album.url }, { proxy, onProgress: tr?.http() }), 2);
      onFile(dest);
      got++;
    } catch (e) { lastErr = e; }
  }
  if (!got && lastErr) throw lastErr;
}
