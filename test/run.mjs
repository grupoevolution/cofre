// Teste de ponta a ponta: sobe o servidor com erome/Bunny simulados e um "site qualquer" local.
// Precisa de ffmpeg/ffprobe instalados. Rodar: npm test
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-test-'));
const M = path.join(root, 'media');
fs.mkdirSync(M);
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
ff('-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=10', '-t', '2', '-metadata', 'title=SEGREDO', '-metadata', 'comment=GPS-XYZ', '-pix_fmt', 'yuv420p', path.join(M, 'v.mp4'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-t', '40', '-pix_fmt', 'yuv420p', path.join(M, 'v2.mp4'));
ff('-f', 'lavfi', '-i', 'color=red:size=300x300', '-frames:v', '1', path.join(M, 'i.jpg'));
ff('-f', 'lavfi', '-i', 'color=blue:size=400x600', '-frames:v', '1', path.join(M, 'i2.jpg'));
ff('-f', 'lavfi', '-i', 'color=green:size=200x200', '-frames:v', '1', path.join(M, 'i3.jpg'));
ff('-f', 'lavfi', '-i', 'color=yellow:size=200x200', '-frames:v', '1', path.join(M, 'i4.jpg'));
ff('-f', 'lavfi', '-i', 'color=purple:size=500x800', '-frames:v', '1', path.join(M, 'i5.jpg'));

// "Site qualquer" local: página com <video>, arquivo direto e a página que o yt-dlp falso reconhece
const site = http.createServer((req, res) => {
  if (req.url === '/pagina') return res.end('<html><head><title>Pagina X</title></head><body><video src="/media/i2.jpg"></video><a href="/media/v.mp4">v</a><a href="media/i5.jpg">foto</a></body></html>');
  if (req.url.startsWith('/media/')) {
    const f = path.join(M, path.basename(req.url));
    if (!fs.existsSync(f)) return res.writeHead(404).end();
    return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404).end();
}).listen(0);
const SITE = `http://127.0.0.1:${site.address().port}`;

const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://127.0.0.1:${PORT}`;
const startServer = (env) => spawn(process.execPath, ['--import', './test/mock-fetch.mjs', 'server.js'], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: path.join(root, 'data'), TEST_MEDIA: M,
    YTDLP_BIN: `${process.execPath}|${path.resolve('test/fake-ytdlp.mjs')}`, GALLERYDL_BIN: 'gallery-dl-nao-existe',
    AUTO_UPDATE_ENGINES: '0', BUNNY_STORAGE_ZONE: 'zona', BUNNY_STORAGE_KEY: 'k3y', BUNNY_CDN_URL: 'https://cdn.teste', ...env,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 60; i++) { try { await fetch(B + '/api/me'); return; } catch { await wait(150); } }
  throw new Error('servidor não subiu');
}
let cookie = '';
const call = async (p, opts = {}) => {
  const r = await fetch(B + p, { ...opts, headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) }, body: opts.body && JSON.stringify(opts.body) });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
};
const act = (body) => call('/api/items/action', { method: 'POST', body });
const items = async (q = '') => (await call('/api/items' + q)).data.items;
let ok = 0;
const pass = (m) => { ok++; console.log('  ✓', m); };

// 1) sem PIN = bloqueado
let srv = startServer({ APP_PIN: '' });
await up();
assert.equal((await call('/api/me')).data.configured, false);
assert.equal((await call('/api/sources')).status, 401);
assert.equal((await call('/api/login', { method: 'POST', body: { pin: '' } })).status, 503);
pass('sem APP_PIN ninguém entra');
srv.kill();
await wait(500);

srv = startServer({ APP_PIN: '4321' });
await up();
try {
  assert.equal((await call('/api/login', { method: 'POST', body: { pin: '0000' } })).status, 401);
  const lg = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pin":"4321"}' });
  cookie = lg.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/me')).data.authed, true);
  pass('PIN certo entra, errado não');

  // 2) pasta + vários links de uma vez
  const folder = (await call('/api/folders', { method: 'POST', body: { name: 'Bruna loira' } })).data;
  const txt = ['olha esses:', 'https://www.erome.com/a/TESTE123', `${SITE}/ytpage/1`, `${SITE}/media/v.mp4`, `${SITE}/pagina`, 'https://www.erome.com/fulana', 'nao e link'].join('\n');
  const add = (await call('/api/sources', { method: 'POST', body: { urls: txt, folderId: folder.id } })).data;
  assert.equal(add.added, 5, JSON.stringify(add));
  pass('5 links colados de uma vez entraram na fila');

  let srcs;
  for (let i = 0; i < 160; i++) {
    srcs = (await call('/api/sources')).data;
    if (srcs.length >= 7 && srcs.every((s) => !['queued', 'downloading'].includes(s.status))) break;
    await wait(500);
  }
  const by = (pred) => srcs.find(pred);
  const er = by((s) => s.id === 'TESTE123');
  assert.equal(er.status, 'partial', JSON.stringify(er));
  assert.equal(er.done, 3);
  assert.equal(er.title, 'Album de teste');
  pass('erome: 3 de 4 baixados, o quebrado ficou marcado como falha');
  const yt = by((s) => s.url.includes('ytpage'));
  assert.equal(yt.status, 'done', JSON.stringify(yt));
  assert.equal(yt.title, 'Meu video');
  pass('site qualquer via yt-dlp: baixou com título');
  const dir = by((s) => s.url.endsWith('/media/v.mp4'));
  assert.equal(dir.duplicates, 1, JSON.stringify(dir));
  pass('anti-duplicado: link direto com o mesmo vídeo do erome foi ignorado');
  const pg = by((s) => s.url.endsWith('/pagina'));
  assert.equal(pg.done, 1, JSON.stringify(pg));
  assert.equal(pg.duplicates, 2, JSON.stringify(pg));
  pass('página sem suporte: leu a página (links relativos inclusos), 1 novo + 2 repetidos ignorados');
  const prof = by((s) => s.kind === 'erome-profile');
  assert.match(prof.note, /2 álbuns/);
  assert.ok(by((s) => s.id === 'AAA111') && by((s) => s.id === 'BBB222'));
  pass('perfil erome virou 2 álbuns separados');

  // 3) biblioteca e filtros
  let lib = await items();
  assert.equal((await items('?folder=' + folder.id)).length, lib.length);
  pass(`biblioteca: ${lib.length} arquivos, todos na pasta escolhida`);
  assert.ok((await items('?orient=v')).some((i) => i.type === 'video' && i.height === 640));
  const mid = await items('?dur=mid');
  assert.equal(mid.length, 1);
  assert.equal(mid[0].duration, 40);
  pass('filtros: vertical e duração');
  const vid = lib.find((i) => i.album === 'TESTE123' && i.type === 'video');
  assert.ok(vid.thumb, 'miniatura');
  const tags = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path.join(root, 'data/albums/TESTE123', vid.file)]).toString();
  assert.ok(!/SEGREDO|GPS-XYZ/.test(tags), tags);
  pass('dados escondidos (título/comentário) removidos do vídeo');

  // 4) ações em lote
  const ids = lib.slice(0, 2).map((i) => i.id);
  await act({ ids, action: 'used' });
  assert.equal((await items('?used=1')).length, 2);
  pass('marcar como usado + filtro "já usei"');
  const f2 = (await call('/api/folders', { method: 'POST', body: { name: 'Criativo' } })).data;
  await act({ ids: [ids[0]], action: 'move', folderId: f2.id });
  assert.deepEqual((await items('?folder=' + f2.id)).map((i) => i.id), [ids[0]]);
  assert.equal((await items('?folder=' + folder.id)).length, lib.length - 1);
  pass('mover para outra pasta');

  // 5) Bunny manual
  assert.equal((await act({ ids, action: 'bunny', bunnyFolder: 'Bruna Loira' })).data.count, 2);
  for (let i = 0; i < 50; i++) { lib = await items('?bunny=1'); if (lib.length === 2) break; await wait(200); }
  assert.equal(lib.length, 2);
  assert.match(lib[0].bunny.url, /^https:\/\/cdn\.teste\/cofre\/bruna-loira\//);
  pass('enviado pro Bunny com link: ' + lib[0].bunny.url);
  await act({ ids: [ids[0]], action: 'freeLocal' });
  const freed = (await items('?bunny=1')).find((i) => i.id === ids[0]);
  assert.equal(freed.local, false);
  assert.equal(freed.src, freed.bunny.url);
  pass('liberar espaço: apagou do servidor, segue visível pelo Bunny');

  // 6) zip
  const z = await call(`/api/folders/${folder.id}/zip`);
  assert.equal(Buffer.from(z.data).subarray(0, 2).toString(), 'PK');
  const zs = await fetch(B + '/api/zip', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ids=' + encodeURIComponent(JSON.stringify(ids)) + '&name=sel' });
  assert.equal(zs.status, 200);
  assert.match(zs.headers.get('content-disposition'), /sel\.zip/);
  pass('baixar .zip da pasta e da seleção');

  // 7) apagado não volta
  const eroDone = (await call('/api/sources/TESTE123')).data.items.filter((i) => i.status === 'done');
  await act({ ids: [eroDone[1].id], action: 'delete' });
  await call('/api/sources/TESTE123/retry', { method: 'POST' });
  await wait(4000);
  assert.equal((await call('/api/sources/TESTE123')).data.items.find((i) => i.id === eroDone[1].id), undefined);
  pass('arquivo apagado não é baixado de novo no "Tentar de novo"');

  // 8) mesmo link de novo
  assert.equal((await call('/api/sources', { method: 'POST', body: { urls: `${SITE}/ytpage/1` } })).data.existed, 1);
  pass('link repetido não baixa de novo');
  console.log(`\n${ok} testes passaram`);
} finally {
  srv.kill();
  site.close();
}
