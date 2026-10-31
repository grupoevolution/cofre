// Teste de ponta a ponta: sobe o servidor com erome/Bunny simulados e um "site qualquer" local.
// Precisa de ffmpeg/ffprobe instalados. Rodar: npm test
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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
ff('-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', path.join(M, 'v3.mp4'));
ff('-f', 'lavfi', '-i', 'life=size=320x240:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', path.join(M, 'v4.mp4'));
// i6 = mesma foto da i2 (azul) com outro tamanho e um risco → arquivo diferente, imagem "parecida"
ff('-f', 'lavfi', '-i', 'testsrc2=size=400x600', '-frames:v', '1', path.join(M, 'i7.jpg'));
ff('-i', path.join(M, 'i7.jpg'), '-vf', 'scale=300:450,drawbox=x=5:y=5:w=20:h=3:color=white', path.join(M, 'i6.jpg'));
ff('-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=10', '-t', '30', '-pix_fmt', 'yuv420p', path.join(M, 'v5.mp4'));
ff('-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=10', '-t', '30', '-pix_fmt', 'yuv420p', path.join(M, 'v6.mp4'));

// Proxy local (túnel CONNECT): conta quantas conexões passaram por ele
let proxyHits = 0;
const proxy = http.createServer((req, res) => {
  proxyHits++; // proxy HTTP comum (URL completa na requisição)
  const up = http.request(req.url, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
}).on('connect', (req, sock, head) => {
  proxyHits++;
  const [h, p] = req.url.split(':');
  const t = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); t.write(head); t.pipe(sock); sock.pipe(t); });
  t.on('error', () => sock.destroy());
  sock.on('error', () => t.destroy());
}).listen(0);
let once403 = 0;

// "Site qualquer" local: página com <video>, arquivo direto e a página que o yt-dlp falso reconhece
const site = http.createServer((req, res) => {
  // link direto que bloqueia a 1ª tentativa (como um site que barra o IP do servidor)
  if (req.url === '/bloqueado/v4.mp4' && once403++ === 0) return res.writeHead(403).end('forbidden');
  if (req.url === '/bloqueado/v4.mp4') return fs.createReadStream(path.join(M, 'v4.mp4')).pipe(res);
  // player que só aparece com JavaScript rodando (yt-dlp/gallery-dl/leitura de HTML não acham)
  if (req.url === '/jsvideo') return res.end('<html><head><title>Player JS</title></head><body><div id="p"></div><script>setTimeout(function(){var v=document.createElement("video");v.src="/stream/"+"v3"+".mp4";v.muted=true;document.getElementById("p").appendChild(v);v.play();},400)</script></body></html>');
  if (req.url === '/stream/v3.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return fs.createReadStream(path.join(M, 'v3.mp4')).pipe(res); }
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
    AUTO_UPDATE_ENGINES: '0', AUTO_TAGS: '0', PROXY_URL: `http://127.0.0.1:${proxy.address().port}`,
    BROWSER_BIN: process.env.BROWSER_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    BUNNY_STORAGE_ZONE: 'zona', BUNNY_STORAGE_KEY: 'k3y', BUNNY_CDN_URL: 'https://cdn.teste', HEALTH_URLS: '', HEALTH_MEM_PCT: '101', HEALTH_CPU_PCT: '101', ...env,
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
  // 9) os 4 recursos novos: proxy, contas, navegador invisível, erro com próximo passo
  const r9 = (await call('/api/sources', { method: 'POST', body: { urls: [
    `${SITE}/ytblock/1`, `${SITE}/bloqueado/v4.mp4`, `${SITE}/ytlogin/1`, `${SITE}/ytdrm/1`, `${SITE}/jsvideo`, `${SITE}/naoexiste`,
  ].join('\n') } })).data;
  assert.equal(r9.added, 6, JSON.stringify(r9));
  const waitAll = async (pred) => {
    for (let i = 0; i < 240; i++) {
      srcs = (await call('/api/sources')).data;
      if (pred(srcs)) return;
      await wait(500);
    }
    throw new Error('demorou: ' + JSON.stringify(srcs.map((s) => [s.url, s.status, s.progress])));
  };
  await waitAll((l) => l.every((s) => !['queued', 'downloading'].includes(s.status)));
  const get = (frag) => srcs.find((s) => s.url.includes(frag));
  assert.equal(get('ytblock').status, 'done', JSON.stringify(get('ytblock')));
  pass('site que bloqueia o servidor: yt-dlp tentou de novo pelo proxy e baixou');
  assert.equal(get('bloqueado/v4').status, 'done', JSON.stringify(get('bloqueado/v4')));
  assert.ok(proxyHits > 0, 'proxy não foi usado');
  pass(`link direto com 403: refez pelo proxy (${proxyHits} conexão(ões) no proxy)`);
  const js = get('jsvideo');
  assert.equal(js.status, 'done', JSON.stringify(js));
  assert.equal(js.title, 'Player JS');
  pass('navegador invisível: pegou o vídeo de um player que só aparece com JavaScript');
  const drm = get('ytdrm');
  assert.equal(drm.errorCode, 'drm', JSON.stringify(drm));
  pass(`DRM: "${drm.error}" → ${drm.hint}`);
  const gone = get('naoexiste');
  assert.equal(gone.errorCode, 'gone', JSON.stringify(gone));
  pass(`link quebrado: "${gone.error}" → ${gone.hint}`);
  const lgn = get('ytlogin');
  assert.equal(lgn.errorCode, 'login', JSON.stringify(lgn));
  assert.match(lgn.hint, /Contas/);
  pass(`pediu login: "${lgn.error}" → ${lgn.hint}`);

  // Contas: cola o JSON do Cookie-Editor → o download que falhou por login volta sozinho e baixa
  const exp = Math.round(Date.now() / 1000) + 30 * 86400;
  const ckJson = JSON.stringify([{ domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: true, expirationDate: exp, name: 'sessao', value: 'abc' }]);
  const acc = (await call('/api/accounts', { method: 'POST', body: { text: ckJson } })).data;
  assert.deepEqual(acc.sites, ['127.0.0.1']);
  assert.equal(acc.retried, 1, JSON.stringify(acc));
  const accList = (await call('/api/accounts')).data;
  assert.equal(accList[0].valid, 1);
  assert.ok(!JSON.stringify(accList).includes('abc'), 'a API não pode devolver o valor do cookie');
  await waitAll((l) => l.find((s) => s.url.includes('ytlogin'))?.status === 'done');
  pass('Contas: colou os cookies → o download que pediu login voltou sozinho e baixou');
  const bad = await call('/api/accounts', { method: 'POST', body: { text: 'isso não é cookie' } });
  assert.equal(bad.status, 400);
  pass(`Contas: formato errado explica o que fazer ("${bad.data.error}")`);
  await call('/api/accounts/127.0.0.1', { method: 'DELETE' });
  assert.equal((await call('/api/accounts')).data.length, 0);
  pass('Contas: remover conta');
  const st = (await call('/api/stats')).data;
  assert.equal(st.proxy, 'fallback');
  assert.equal(st.browser, true);
  pass('painel Sistema: proxy "só quando bloquear" + navegador ligado');

  // 10) organização: favorito, etapas, legendas, persona, parecido, prévia, corte, direto pro Bunny, atividade
  const fresh = (await items()).filter((i) => i.type === 'image');
  const [a1, a2] = fresh;
  await act({ ids: [a1.id], action: 'fav' });
  assert.deepEqual((await items('?fav=1')).map((i) => i.id), [a1.id]);
  pass('favoritos ⭐ + filtro');
  await act({ ids: [a2.id], action: 'approve' });
  assert.ok((await items('?stage=selecionado')).some((i) => i.id === a2.id));
  const stg = (await call('/api/stats')).data.stages;
  assert.ok(stg.bruto > 0 && stg.selecionado >= 1 && stg.usado >= 1, JSON.stringify(stg));
  pass(`etapas: ${JSON.stringify(stg)}`);
  await act({ ids: [a1.id, a2.id], action: 'setTags', tags: ['Loira', 'quarto'] });
  assert.equal((await items('?tag=loira,quarto')).length, 2);
  assert.equal((await items('?q=quarto')).length, 2);
  assert.ok((await call('/api/tags')).data.some((t) => t.tag === 'loira' && t.n === 2 && t.group === 'cabelo'));
  pass('legendas: editar, filtrar, buscar e contar');
  const bruna = (await call('/api/folders', { method: 'POST', body: { name: 'Bruna', persona: true, appName: 'Bruna' } })).data;
  const carla = (await call('/api/folders', { method: 'POST', body: { name: 'Carla', persona: true } })).data;
  await act({ ids: [a1.id], action: 'addFolder', folderId: bruna.id });
  await act({ ids: [a1.id], action: 'used', folderId: bruna.id });
  const conf = (await act({ ids: [a1.id, a2.id], action: 'addFolder', folderId: carla.id })).data;
  assert.equal(conf.conflicts.length, 1);
  assert.deepEqual(conf.conflicts[0].personas, ['Bruna']);
  pass('persona: avisa que a foto já é da "Bruna" ao pôr na "Carla"');

  // parecido + prévia + direto pro Bunny (mesmo link de download)
  await call('/api/sources', { method: 'POST', body: { urls: `${SITE}/media/i7.jpg\n${SITE}/media/v5.mp4` } });
  await waitAll((l) => l.filter((s) => /i7\.jpg|v5\.mp4/.test(s.url)).every((s) => s.status === 'done'));
  await call('/api/sources', { method: 'POST', body: { urls: `${SITE}/media/i6.jpg`, bunnyFolder: 'Arsenal Bruna' } });
  await waitAll((l) => l.find((s) => s.url.endsWith('i6.jpg'))?.status === 'done');
  let i6;
  for (let i = 0; i < 40; i++) { i6 = (await items()).find((x) => x.file === 'i6.jpg'); if (i6?.bunny?.status === 'done') break; await wait(250); }
  assert.ok(i6.similarTo?.endsWith('i7.jpg'), JSON.stringify(i6));
  assert.ok((await items('?similar=1')).some((x) => x.id === i6.id));
  pass('quase-duplicado: mesma foto em outro tamanho foi marcada como parecida');
  assert.equal(i6.bunny.status, 'done');
  assert.match(i6.bunny.url, /\/cofre\/arsenal-bruna\//);
  assert.equal(i6.local, false);
  pass('direto pro Bunny: baixou, enviou pra "arsenal-bruna" e apagou do servidor');
  await act({ ids: [i6.id], action: 'ignoreSimilar' });
  assert.ok(!(await items('?similar=1')).some((x) => x.id === i6.id));
  pass('parecido: "manter os dois" tira o aviso');
  const v5 = (await items()).find((x) => x.file === 'v5.mp4');
  assert.ok(v5.sprite, 'vídeo de 30 s deveria ter prévia');
  const sp = await call(v5.sprite);
  assert.equal(sp.status, 200);
  pass('prévia de vídeo longo (24 quadros) gerada');

  // corte
  const cut = await call('/api/items/clip', { method: 'POST', body: { id: v5.id, start: 5, end: 12 } });
  assert.equal(cut.status, 202, JSON.stringify(cut.data));
  let clip;
  for (let i = 0; i < 60; i++) { clip = (await items()).find((x) => x.clipOf === v5.id); if (clip) break; await wait(300); }
  assert.ok(clip, 'corte não apareceu');
  assert.ok(Math.abs(clip.duration - 7) < 0.6, 'duração do corte: ' + clip.duration);
  assert.equal(clip.similarTo, null);
  pass(`cortar trecho: 0:05–0:12 virou um vídeo de ${clip.duration}s`);
  const badCut = await call('/api/items/clip', { method: 'POST', body: { id: v5.id, start: 10, end: 8 } });
  assert.equal(badCut.status, 400);
  pass('corte com fim antes do início é recusado com explicação');

  // fotos tiradas do vídeo
  const deriveIdle = async () => { for (let i = 0; i < 160; i++) { const st = (await call('/api/activity')).data.derive; if (!st.current && !st.queue) return; await wait(500); } throw new Error('kit/fotos demorou'); };
  await call('/api/items/frames', { method: 'POST', body: { ids: [v5.id] } });
  await deriveIdle();
  assert.equal((await items()).filter((x) => x.frameOf === v5.id).length, 1);
  pass('vídeo parado (mesma imagem o tempo todo) gera 1 foto, não várias repetidas');
  await call('/api/sources', { method: 'POST', body: { urls: `${SITE}/media/v6.mp4` } });
  let v6;
  for (let i = 0; i < 80 && !v6; i++) { v6 = (await items()).find((x) => x.file.endsWith('v6.mp4') || x.title?.includes('v6')); if (!v6) await wait(400); }
  assert.ok(v6, 'v6 não baixou');
  const fr = await call('/api/items/frames', { method: 'POST', body: { ids: [v6.id] } });
  assert.equal(fr.status, 202, JSON.stringify(fr.data));
  await deriveIdle();
  const frames = (await items()).filter((x) => x.frameOf === v6.id);
  assert.ok(frames.length >= 2, 'poucas fotos: ' + frames.length);
  assert.ok(frames.every((f) => f.type === 'image' && f.width >= 300 && !f.similarTo), JSON.stringify(frames.map((f) => [f.file, f.width, f.similarTo])));
  assert.equal(new Set(frames.map((f) => f.file)).size, frames.length);
  pass(`fotos do vídeo: ${frames.length} fotos nítidas e diferentes entre si (${frames.map((f) => f.frameAt + 's').join(', ')})`);

  // kit pro app: foto e trecho de vídeo
  const photo = (await items('?type=image&derived=orig')).find((x) => x.local && x.width);
  const kp = await call('/api/items/kit', { method: 'POST', body: { ids: [photo.id], formats: ['916', '45', 'blur'] } });
  assert.equal(kp.status, 202, JSON.stringify(kp.data));
  const kv = await call('/api/items/kit', { method: 'POST', body: { ids: [v5.id], formats: ['916'], start: 2, end: 8 } });
  assert.equal(kv.status, 202);
  let kit = [];
  for (let i = 0; i < 120; i++) {
    kit = (await items('?derived=kit')).filter((x) => x.kitOf === photo.id || x.kitOf === v5.id);
    const st = (await call('/api/activity')).data.derive;
    if (kit.length >= 4 && !st.current && !st.queue) break;
    await wait(500);
  }
  const k = (of, fmt) => kit.find((x) => x.kitOf === of && x.kit === fmt);
  const ratio = (x) => x.width / x.height;
  assert.ok(Math.abs(ratio(k(photo.id, '916')) - 9 / 16) < 0.02, '9:16 da foto: ' + JSON.stringify(k(photo.id, '916')));
  assert.ok(Math.abs(ratio(k(photo.id, '45')) - 4 / 5) < 0.02, '4:5 da foto');
  assert.ok(k(photo.id, 'blur')?.status === 'done', 'borrada');
  const v916 = k(v5.id, '916');
  assert.ok(v916 && Math.abs(ratio(v916) - 9 / 16) < 0.02 && Math.abs(v916.duration - 6) < 0.6, JSON.stringify(v916));
  pass(`kit pro app: foto em 9:16 (${k(photo.id, '916').width}×${k(photo.id, '916').height}), 4:5 e borrada + trecho de vídeo 9:16 de ${v916.duration}s`);
  assert.ok((await items('?derived=orig')).every((x) => !x.kitOf && !x.frameOf));
  pass('filtro "só originais" esconde fotos tiradas e kit');

  // atividade
  const actv = (await call('/api/activity')).data;
  const rec = actv.recent.find((r) => r.url.endsWith('v5.mp4'));
  assert.ok(rec && rec.log.some((l) => /Terminou/.test(l.msg)), JSON.stringify(rec?.log));
  assert.ok(Array.isArray(actv.uploads) && 'uploadQueue' in actv);
  pass('atividade: histórico com diário de cada download');

  // ---------- Vigia da VPS: freio automático ----------
  let appOk = true;
  const appSrv = http.createServer((q, r) => { r.writeHead(appOk ? 200 : 503, { 'Content-Type': 'application/json' }); r.end('{"status":"ok"}'); }).listen(0);
  const APPURL = `http://127.0.0.1:${appSrv.address().port}/health`;
  srv.kill();
  await wait(500);
  srv = startServer({
    APP_PIN: '4321', HEALTH_URLS: `App teste=${APPURL}`, HEALTH_APP_SEC: '1', HEALTH_SAMPLE_SEC: '1',
    HEALTH_DISK_LOCAL_GB: '100000', // força "disco apertado" para testar o bloqueio de guardar no servidor
  });
  await up();
  try {
    const lg2 = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pin":"4321"}' });
    cookie = lg2.headers.get('set-cookie').split(';')[0];
    await wait(1500);
    let st = (await call('/api/stats')).data;
    assert.ok(st.health?.disk?.total > 0 && st.health.mem?.total > 0 && st.health.cpu?.cores > 0, JSON.stringify(st.health));
    assert.ok(st.health.apps[0].ok && st.health.apps[0].ms != null, JSON.stringify(st.health.apps));
    pass(`vigia: disco/memória/processador medidos e app respondendo em ${st.health.apps[0].ms} ms`);

    const local = await call('/api/sources', { method: 'POST', body: { urls: `${SITE}/media/vigia1/i6.jpg` } });
    assert.equal(local.status, 409, JSON.stringify(local.data));
    assert.match(local.data.error, /Direto pro Bunny/);
    pass('disco apertado: recusa guardar no servidor e manda usar "Direto pro Bunny"');

    appOk = false;
    for (let i = 0; i < 30 && st.health.brake.level !== 'stop'; i++) { await wait(300); st = (await call('/api/stats')).data; }
    assert.equal(st.health.brake.level, 'stop', JSON.stringify(st.health.brake));
    assert.match(st.health.brake.reasons.join(), /App teste/);
    const viaBunny = await call('/api/sources', { method: 'POST', body: { urls: `${SITE}/media/vigia2/i6.jpg`, bunnyFolder: 'vigia' } });
    assert.equal(viaBunny.status, 201);
    const vid = viaBunny.data.results[0].id;
    await wait(2000);
    assert.equal((await call('/api/sources/' + vid)).data.status, 'queued');
    pass('app de venda fora do ar: Cofre pausa a fila sozinho ("' + st.health.brake.reasons[0] + '")');

    appOk = true;
    let a2;
    for (let i = 0; i < 60; i++) { a2 = (await call('/api/sources/' + vid)).data; if (['done', 'partial', 'error'].includes(a2.status)) break; await wait(300); }
    assert.equal(a2.status, 'done', JSON.stringify(a2));
    pass('app voltou: freio solta e a fila retoma sozinha');
  } finally { appSrv.close(); }

  console.log(`\n${ok} testes passaram`);
} finally {
  srv.kill();
  site.close();
  proxy.close();
}
