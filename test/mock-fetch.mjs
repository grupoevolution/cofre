// Simula erome e Bunny dentro do servidor (só para teste). Carregado com: node --import ./test/mock-fetch.mjs server.js
import fs from 'node:fs';
import path from 'node:path';

const M = process.env.TEST_MEDIA;
const HTML = `<html><head><meta property="og:title" content="Album de teste"></head><body>
<div class="page-content"><h1>Album de teste</h1><a id="user_name" href="#">criador1</a>
<div class="media-group" id="1"><div class="video"><video poster="https://s1.erome.com/1/thumbs/x.jpg"><source src="https://v1.erome.com/1/abc/v1_720p.mp4" type="video/mp4" res="720"></video></div></div>
<div class="media-group" id="2"><div class="img" data-src="https://s1.erome.com/1/abc/p1.jpeg?v=1"><img class="img-front lasyload" data-src="https://s1.erome.com/1/abc/p1.jpeg?v=1"></div></div>
<div class="media-group" id="3"><div class="img" data-src="https://s1.erome.com/1/abc/p2.jpg"></div></div>
<div class="media-group" id="4"><video><source src="https://v1.erome.com/1/abc/broken.mp4"></video></div>
</div></body></html>`;
const PROFILE = (p) => (p === 1 ? '<a href="https://www.erome.com/a/AAA111">x</a><a href="/a/BBB222">y</a>' : '<p>fim</p>');
const file = (n) => new Response(fs.readFileSync(path.join(M, n)));

const real = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const h = opts.headers || {};
  if (/storage\.bunnycdn\.com/.test(u)) {
    if (h.AccessKey !== 'k3y') return new Response('unauthorized', { status: 401 });
    for await (const _ of opts.body) { /* consome o envio */ }
    fs.appendFileSync(path.join(M, 'bunny.log'), u + '\n');
    return new Response('{"HttpCode":201}', { status: 201 });
  }
  if (!/erome\.com/.test(u)) return real(url, opts);
  if (!/Mobile/.test(h['User-Agent'] || '')) return new Response('desktop bloqueado', { status: 403 });
  const pg = u.match(/erome\.com\/fulana\?page=(\d+)/);
  if (pg) return new Response(PROFILE(Number(pg[1])));
  if (u.includes('/a/AAA111') || u.includes('/a/BBB222')) {
    return new Response(`<div class="media-group"><div class="img" data-src="https://s1.erome.com/9/${u.includes('AAA') ? 'q1' : 'q2'}.jpg"></div></div>`);
  }
  if (u.includes('/a/')) return new Response(HTML, { headers: { 'content-type': 'text/html' } });
  if (h.Referer !== 'https://www.erome.com/') return new Response('sem referer', { status: 403 });
  if (u.endsWith('v1_720p.mp4')) return file('v.mp4');
  if (/p1\.jpeg/.test(u)) return file('i.jpg');
  if (/p2\.jpg/.test(u)) return file('i2.jpg');
  if (/q1\.jpg/.test(u)) return file('i3.jpg');
  if (/q2\.jpg/.test(u)) return file('i4.jpg');
  return new Response('nope', { status: 404 });
};
