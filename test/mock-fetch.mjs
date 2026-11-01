// Redireciona chamadas ao erome para uma página simulada local (só para teste).
import fs from 'node:fs';
const HTML = `<html><head><meta property="og:title" content="Album de teste"></head><body>
<div class="page-content"><h1>Album de teste</h1><a id="user_name" href="#">criador1</a>
<div class="media-group" id="1"><div class="video"><video poster="https://s1.erome.com/1/thumbs/x.jpg"><source src="https://v1.erome.com/1/abc/v1_720p.mp4" type="video/mp4" res="720"></video></div></div>
<div class="media-group" id="2"><div class="img" data-src="https://s1.erome.com/1/abc/p1.jpeg?v=1"><img class="img-front lasyload" data-src="https://s1.erome.com/1/abc/p1.jpeg?v=1"><img class="img-back lasyload" data-src="https://s1.erome.com/1/abc/p1.jpeg?v=1"></div></div>
<div class="media-group" id="3"><div class="img" data-src="https://s1.erome.com/1/abc/p2.jpg"></div></div>
<div class="media-group" id="4"><video><source src="https://v1.erome.com/1/abc/broken.mp4"></video></div>
</div></body></html>`;
const real = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const h = opts.headers || {};
  if (!/erome\.com/.test(u)) return real(url, opts);
  if (!/Mobile/.test(h['User-Agent'] || '')) return new Response('desktop bloqueado', { status: 403 });
  if (u.includes('/a/')) return new Response(HTML, { headers: { 'content-type': 'text/html' } });
  if (h.Referer !== 'https://www.erome.com/') return new Response('sem referer', { status: 403 });
  if (u.endsWith('.mp4') && !u.includes('broken')) return new Response(fs.readFileSync('/tmp/v.mp4'));
  if (/p\d\.jpe?g/.test(u)) return new Response(fs.readFileSync('/tmp/i.jpg'));
  return new Response('nope', { status: 404 });
};
