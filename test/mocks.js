// Servidor falso do erome + Bunny (Storage e Stream) para testar sem internet.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const KEY = { storage: 'sk', stream: 'vk' };

export function startMocks() {
  const storage = new Map(); // "dir/arquivo" -> { size, sha }
  const videos = new Map();  // guid -> { status, size, collectionId, title }
  const collections = new Map();
  const hits = { media: 0, active: 0, maxActive: 0 };
  let base;

  const page = (album, kind) => {
    const v = (n) => `<div class="media-group"><div class="video"><video><source src="${base}/cdn/${album}/v${n}.mp4" type="video/mp4"></video></div></div>`;
    const i = (n) => `<div class="media-group"><div class="img" data-src="${base}/cdn/${album}/p${n}.jpg?v=1"></div></div>`;
    const body = kind === 'stall' ? `<div class="media-group"><video><source src="${base}/cdn/${album}/stall.mp4"></video></div>` : kind === 'videos' ? v(1) + v(2) : kind === 'broken' ? v(1) + `<div class="media-group"><video><source src="${base}/cdn/${album}/broken.mp4"></video></div>` : v(1) + i(1) + i(2);
    return `<html><head><meta property="og:title" content="Album ${album}"></head><body><a id="user_name">Criador Um</a>${body}</body></html>`;
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

      // ---- erome ----
      let m;
      if ((m = u.pathname.match(/^\/a\/(\w+)$/))) {
        if (!/Mobile/.test(req.headers['user-agent'] || '')) return json(403, {});
        const kind = m[1].startsWith('stall') ? 'stall' : m[1].startsWith('vid') ? 'videos' : m[1].startsWith('bad') ? 'broken' : 'mixed';
        if (m[1].startsWith('gone')) return json(404, {});
        res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(m[1], kind));
      }
      // "xvideos"/"TikTok" falsos: o yt-dlp recebe um mp4 direto (extrator genérico)
      if (/\/(xvideos\.com\/video|tiktok\.com\/@)/.test(u.pathname)) {
        if (u.pathname.includes('gone')) return json(404, {});
        const f = fs.readFileSync(path.join(FIX, u.pathname.includes('hevc') ? 'hevc.mp4' : 'v.mp4'));
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': f.length }); return res.end(f);
      }
      if (u.pathname.startsWith('/cdn/')) {
        hits.media++;
        if (req.headers.referer !== 'https://www.erome.com/') return json(403, {});
        if (u.pathname.includes('broken')) return json(404, {});
        const f = fs.readFileSync(path.join(FIX, u.pathname.endsWith('.mp4') ? 'v.mp4' : 'i.jpg'));
        res.writeHead(200, { 'content-length': f.length });
        if (u.pathname.includes('stall')) { res.write(f.subarray(0, 1000)); return; } // trava no meio e nunca termina
        hits.active++; hits.maxActive = Math.max(hits.maxActive, hits.active);
        return setTimeout(() => { hits.active--; res.end(f); }, 150);
      }

      // ---- Bunny Stream ----
      if (u.pathname.startsWith('/stream/library/L1')) {
        if (req.headers.accesskey !== KEY.stream) return json(401, { Message: 'unauthorized' });
        const p = u.pathname.replace('/stream/library/L1', '');
        if (p === '/collections' && req.method === 'POST') {
          const guid = crypto.randomUUID(); collections.set(guid, JSON.parse(body).name); return json(200, { guid });
        }
        if (p === '/videos' && req.method === 'POST') {
          const b = JSON.parse(body);
          if (b.collectionId && !collections.has(b.collectionId)) return json(400, { Message: 'collection not found' });
          const guid = crypto.randomUUID(); videos.set(guid, { status: 0, size: 0, ...b }); return json(200, { guid });
        }
        if ((m = p.match(/^\/videos\/([\w-]+)$/))) {
          const v = videos.get(m[1]);
          if (!v) return json(404, {});
          if (req.method === 'PUT') {
            v.status = 1; v.size = body.length;
            setTimeout(() => { v.status = 3; }, 300); setTimeout(() => { v.status = 4; }, 1500);
            return json(200, { success: true });
          }
          return json(200, { guid: m[1], status: v.status, storageSize: v.size });
        }
        return json(404, {});
      }

      // ---- Bunny Storage ----
      if (u.pathname.startsWith('/zona/')) {
        if (req.headers.accesskey !== KEY.storage) return json(401, {});
        const p = decodeURIComponent(u.pathname.slice('/zona/'.length));
        if (req.method === 'PUT') {
          const sha = crypto.createHash('sha256').update(body).digest('hex').toUpperCase();
          if (req.headers.checksum && req.headers.checksum !== sha) return json(400, { Message: 'Checksum mismatch' });
          storage.set(p, { size: body.length, sha }); return json(201, { HttpCode: 201 });
        }
        if (req.method === 'GET' && p.endsWith('/')) {
          const dir = p.slice(0, -1);
          const list = [...storage].filter(([k]) => path.posix.dirname(k) === dir)
            .map(([k, v]) => ({ ObjectName: path.posix.basename(k), Length: v.size, Checksum: v.sha, IsDirectory: false }));
          return json(200, list);
        }
      }
      json(404, {});
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    r({ base, server, storage, videos, collections, hits });
  }));
}
