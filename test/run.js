// Teste de ponta a ponta: sobe erome/Bunny falsos, sobe o Cofre e passa pelo fluxo completo.
// Rodar: npm test   (precisa de ffmpeg instalado)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMocks, KEY } from './mocks.js';
import { parseAlbum, albumUrlsFromText } from '../lib/erome.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

// ---- unidade: leitor do erome ----
{
  const html = `<div class="media-group"><video><source src="https://v.erome.com/a.mp4"></video></div>
    <div class="media-group"><div class="img" data-src="https://s.erome.com/b.jpg?v=1"><img data-src="https://s.erome.com/b.jpg?v=1"></div></div>`;
  const r = parseAlbum(html, 'https://www.erome.com/a/x');
  assert.deepEqual(r.items.map((i) => i.type), ['video', 'image']);
  assert.equal(albumUrlsFromText('olha https://www.erome.com/a/AbC1 e erome.com/a/zz9\nhttps://www.erome.com/a/AbC1').length, 2);
  ok('leitor do erome e vários links num texto');
}

const mock = await startMocks();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-test-'));

// versão antiga: um álbum já baixado para testar a migração
fs.mkdirSync(path.join(dataDir, 'albums', 'old1'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'test/fixtures/i.jpg'), path.join(dataDir, 'albums/old1/001.jpg'));
fs.writeFileSync(path.join(dataDir, 'albums/old1/meta.json'), JSON.stringify({ id: 'old1', url: 'https://www.erome.com/a/old1',
  title: 'Antigo', author: 'fulano', status: 'done', items: [{ type: 'image', file: '001.jpg', status: 'done', size: 49491 }] }));

const PORT = 3900 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', './test/redirect-erome.mjs', 'server.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT, DATA_DIR: dataDir, APP_PIN: '4321', MOCK_BASE: mock.base, NODE_ENV: 'test',
    BUNNY_STORAGE_ZONE: 'zona', BUNNY_STORAGE_KEY: KEY.storage, BUNNY_STORAGE_HOST: mock.base, BUNNY_STORAGE_CDN: 'https://cdn.teste',
    BUNNY_STREAM_LIBRARY_ID: 'L1', BUNNY_STREAM_KEY: KEY.stream, BUNNY_STREAM_API: mock.base + '/stream',
    DOWNLOAD_CONCURRENCY: '2', MIN_FREE_GB: '0', STALL_TIMEOUT_SEC: '2', FFMPEG_THREADS: '1', HTTPS_PROXY: '', HTTP_PROXY: '' },
});
let log = '';
srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });

const B = `http://127.0.0.1:${PORT}`;
let cookie = '';
async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando: ' + what);
    await sleep(300);
  }
}
const folder = async (id) => (await api('/api/folders/' + id)).body;

try {
  await until(async () => (await fetch(B + '/api/health').catch(() => null))?.ok, 'servidor subir', 15000);

  assert.equal((await api('/api/folders')).status, 401);
  assert.equal((await api('/api/login', { method: 'POST', body: { pin: '0000' } })).status, 401);
  assert.equal((await api('/api/login', { method: 'POST', body: { pin: '4321' } })).status, 200);
  ok('login: bloqueia sem PIN, recusa PIN errado, aceita o certo');

  const folders0 = (await api('/api/folders')).body;
  const imp = folders0.find((f) => f.slug === 'importados');
  assert.ok(imp && imp.stats.ready === 1, 'migração');
  assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith('albums.antigo-')));
  ok('migração da versão antiga para a pasta "Importados"');

  const f1 = (await api('/api/folders', { method: 'POST', body: { name: 'Criativos de imagem' } })).body;
  assert.equal(f1.slug, 'criativos-de-imagem');
  let r = await api('/api/imports', { method: 'POST', body: { folderId: f1.id, text: 'https://www.erome.com/a/mix1\nhttps://www.erome.com/a/bad1' } });
  assert.equal(r.body.created, 2);
  await until(async () => { const f = await folder(f1.id); return f.media.length === 5 && f.stats.busy === 0; }, 'downloads');
  let f = await folder(f1.id);
  assert.equal(f.media.filter((m) => m.status === 'ready').length, 4);
  assert.equal(f.media.filter((m) => m.status === 'error').length, 1);
  assert.ok(f.media.filter((m) => m.status === 'ready').every((m) => m.thumb), 'miniaturas');
  assert.ok(f.media.find((m) => m.type === 'video' && m.status === 'ready').duration > 3);
  ok('baixa 2 álbuns em paralelo, gera miniaturas de foto e vídeo, marca o arquivo quebrado como erro');

  const ready = f.media.filter((m) => m.status === 'ready');
  const vid = ready.find((m) => m.type === 'video'), img = ready.find((m) => m.type === 'image');
  assert.equal((await fetch(`${B}/media/${vid.id}`, { headers: { cookie, range: 'bytes=0-99' } })).status, 206);
  assert.equal((await fetch(`${B}/media/${vid.id}?dl=1`, { headers: { cookie } })).headers.get('content-disposition').includes(vid.name), true);
  ok('arquivos com Range (player) e download com nome certo');

  // ---- edição ----
  r = await api(`/api/media/${img.id}/edit`, { method: 'POST', body: { spec: { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }, blur: { areas: [{ x: 0, y: 0, w: 0.3, h: 0.3 }], strength: 3 } } } });
  assert.equal(r.status, 201);
  const e1 = r.body.id;
  r = await api(`/api/media/${vid.id}/edit`, { method: 'POST', body: { spec: { trim: { start: 1, end: 3 }, crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, blur: { all: true, strength: 1 } } } });
  const e2 = r.body.id;
  r = await api(`/api/media/${img.id}/edit`, { method: 'POST', body: { spec: { toVideo: { duration: 2 }, crop: { x: 0, y: 0, w: 1, h: 0.5625 } } } });
  const e3 = r.body.id;
  assert.equal(r.body.type, 'video');
  assert.equal((await api(`/api/media/${img.id}/edit`, { method: 'POST', body: { spec: {} } })).status, 400);
  await until(async () => (await folder(f1.id)).media.filter((m) => [e1, e2, e3].includes(m.id) && m.status === 'ready').length === 3, 'edições', 60000);
  f = await folder(f1.id);
  const byId = (id) => f.media.find((m) => m.id === id);
  assert.deepEqual([byId(e1).width, byId(e1).height], [400, 400]);
  assert.ok(Math.abs(byId(e2).duration - 2) < 0.3, 'corte de duração: ' + byId(e2).duration);
  assert.equal(byId(e2).width, 320);
  assert.ok(Math.abs(byId(e3).duration - 2) < 0.3 && byId(e3).width === 800);
  assert.ok(byId(e1).name.includes('_ed'));
  ok('edição: recorte + borrão de área (foto), corte de duração + recorte + borrão total (vídeo), foto → vídeo');

  // ---- Bunny Storage (pasta mista) ----
  const toSend = f.media.filter((m) => m.status === 'ready').map((m) => m.id);
  r = await api('/api/media/action', { method: 'POST', body: { action: 'send', ids: [...toSend, f.media.find((m) => m.status === 'error').id] } });
  assert.equal(r.body.queued, toSend.length);
  assert.equal(r.body.skipped.length, 1);
  await until(async () => (await folder(f1.id)).media.filter((m) => m.bunny_status === 'sent').length === toSend.length, 'envio ao Storage');
  f = await folder(f1.id);
  assert.ok(f.media.filter((m) => m.bunny_status === 'sent').every((m) => m.bunny_target === 'storage'));
  assert.equal([...mock.storage.keys()].filter((k) => k.startsWith('criativos-de-imagem/')).length, toSend.length);
  assert.ok(f.media.find((m) => m.bunny_status === 'sent').bunny_url.startsWith('https://cdn.teste/criativos-de-imagem/'));
  ok('pasta mista → Bunny Storage na pasta "criativos-de-imagem", com checksum e conferência');

  // arquivo some do Bunny → não pode ser apagado do sistema
  const victim = f.media.find((m) => m.bunny_status === 'sent');
  mock.storage.delete(victim.bunny_path);
  r = await api('/api/media/action', { method: 'POST', body: { action: 'free', ids: toSend } });
  assert.equal(r.body.freed, toSend.length - 1);
  assert.equal(r.body.failed.length, 1);
  f = await folder(f1.id);
  assert.equal(f.media.find((m) => m.id === victim.id).local, true);
  assert.equal(f.media.find((m) => m.id === victim.id).bunny_status, 'error');
  assert.equal(f.stats.local, 2); // o que falhou no Bunny + o erro de download
  assert.equal((await fetch(`${B}/thumb/${toSend[0]}`, { headers: { cookie } })).status, 200);
  ok('liberar espaço: apaga só o que foi conferido no Bunny; o que sumiu de lá fica no sistema');

  // reenviar e alimentar a pasta de novo
  await api('/api/media/action', { method: 'POST', body: { action: 'retry', ids: [victim.id] } });
  await until(async () => (await folder(f1.id)).media.find((m) => m.id === victim.id).bunny_status === 'sent', 'reenvio');
  await api('/api/imports', { method: 'POST', body: { folderId: f1.id, text: 'https://www.erome.com/a/mix2' } });
  await until(async () => (await folder(f1.id)).media.filter((m) => m.status === 'ready' && m.local).length === 4, 'segundo lote');
  ok('reenvio após erro e pasta "alimentada" de novo depois de liberar espaço');

  // pasta mista, mas enviando UM vídeo sozinho → Stream
  f = await folder(f1.id);
  const lone = f.media.find((m) => m.type === 'video' && m.status === 'ready' && m.local && !m.bunny_status);
  await api('/api/media/action', { method: 'POST', body: { action: 'send', ids: [lone.id] } });
  await until(async () => (await folder(f1.id)).media.find((m) => m.id === lone.id).bunny_status === 'sent', 'vídeo sozinho no Stream');
  assert.equal((await folder(f1.id)).media.find((m) => m.id === lone.id).bunny_target, 'stream');
  ok('pasta mista, vídeo enviado sozinho → Bunny Stream');

  // ---- Bunny Stream (pasta só de vídeo) ----
  const f2 = (await api('/api/folders', { method: 'POST', body: { name: 'Vídeos Reels' } })).body;
  await api('/api/imports', { method: 'POST', body: { folderId: f2.id, text: 'erome.com/a/vid1' } });
  await until(async () => (await folder(f2.id)).stats.ready === 2, 'download vídeos');
  const vids = (await folder(f2.id)).media.map((m) => m.id);
  await api('/api/media/action', { method: 'POST', body: { action: 'send', ids: vids } });
  await until(async () => (await folder(f2.id)).media.some((m) => m.bunny_status === 'verifying'), 'verificando');
  await until(async () => (await folder(f2.id)).media.every((m) => m.bunny_status === 'sent'), 'Stream pronto');
  const f2d = await folder(f2.id);
  assert.ok(f2d.media.every((m) => m.bunny_target === 'stream'));
  assert.ok([...mock.collections.values()].includes('Vídeos Reels'));
  r = await api('/api/media/action', { method: 'POST', body: { action: 'free', ids: vids } });
  assert.equal(r.body.freed, 2);
  ok('pasta só de vídeo → Bunny Stream, numa coleção com o nome da pasta, confirmado quando o Bunny termina');

  // ---- mover, apagar, zip, pasta ----
  await api('/api/media/action', { method: 'POST', body: { action: 'move', folderId: f2.id, ids: [e3] } });
  assert.equal((await folder(f2.id)).media.some((m) => m.id === e3), true);
  const zr = await fetch(B + '/api/zip', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'ids=' + e3 });
  assert.equal(zr.status, 200); assert.ok((await zr.arrayBuffer()).byteLength > 1000);
  await api('/api/media/action', { method: 'POST', body: { action: 'delete', ids: [e3] } });
  assert.equal(fs.existsSync(path.join(dataDir, 'media', `${e3}.mp4`)), false);
  r = await api('/api/folders/' + f2.id, { method: 'PATCH', body: { name: 'Reels', dest: 'storage' } });
  assert.equal(r.body.name, 'Reels'); assert.equal(r.body.slug, 'videos-reels');
  ok('mover, .zip, apagar e renomear pasta (o caminho no Bunny continua o mesmo)');

  // ---- travas ----
  assert.ok(mock.hits.maxActive <= 2, 'downloads simultâneos: ' + mock.hits.maxActive);
  ok(`nunca passou de 2 downloads ao mesmo tempo (máx. visto: ${mock.hits.maxActive})`);
  await api('/api/imports', { method: 'POST', body: { folderId: f2.id, text: 'erome.com/a/stall1' } });
  const t0 = Date.now();
  await until(async () => (await folder(f2.id)).media.some((m) => m.status === 'error' && /parado/.test(m.error)), 'download travado', 60000);
  ok(`download travado é abortado sozinho e não prende a fila (${Math.round((Date.now() - t0) / 1000)}s com 3 tentativas)`);
  assert.ok(!/Error|TypeError/.test(log), 'erros no log:\n' + log);
  const st = (await api('/api/status')).body;
  assert.equal(st.limits.downloads, 2);
  ok('status com limites e espaço em disco');

  console.log('\nTudo certo ✔');
} catch (e) {
  console.error('\nFALHOU:', e.message, '\n--- log do servidor ---\n' + log);
  process.exitCode = 1;
} finally {
  srv.kill(); mock.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
